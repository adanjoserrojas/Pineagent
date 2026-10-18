//! A thin workspace client. It never executes repository code or calls models.
pub mod transport;
pub mod ui;

use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, VecDeque};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub run_id: String,
    pub owner_id: String,
    pub task: String,
    pub state: String,
    pub seq: u64,
    pub router_mode: Option<String>,
    pub coding_recovery: Option<String>,
    #[serde(default)]
    pub candidates: Vec<Value>,
    #[serde(default)]
    pub steps: Vec<Value>,
    #[serde(default)]
    pub write_set: Vec<String>,
    pub error: Option<Value>,
    pub blocked_on: Option<Value>,
}

#[derive(Debug, PartialEq)]
pub struct Request {
    pub event: &'static str,
    pub body: Value,
}

pub fn command(line: &str) -> Result<Request, &'static str> {
    if line.len() > 8_000 {
        return Err("Command too long (maximum 8,000 bytes).");
    }
    let (name, rest) = line.trim().split_once(' ').unwrap_or((line.trim(), ""));
    let rest = rest.trim();
    let request = match name {
        "run" if !rest.is_empty() => Request {
            event: "run:start",
            body: json!({"task": rest}),
        },
        "runs" if rest.is_empty() => Request {
            event: "run:list",
            body: json!({}),
        },
        "pause" | "resume" if !rest.is_empty() && !rest.contains(char::is_whitespace) => Request {
            event: if name == "pause" {
                "run:pause"
            } else {
                "run:resume"
            },
            body: json!({"runId": rest}),
        },
        "approve" => {
            let (run, candidate) = rest
                .split_once(' ')
                .ok_or("Usage: approve RUN_ID CANDIDATE_ID")?;
            if run.is_empty() || candidate.is_empty() || candidate.contains(char::is_whitespace) {
                return Err("Usage: approve RUN_ID CANDIDATE_ID");
            }
            Request {
                event: "run:approve",
                body: json!({"runId": run, "candidateId": candidate}),
            }
        }
        "reject" => {
            let (run, hint) = rest.split_once(' ').ok_or("Usage: reject RUN_ID HINT")?;
            if run.is_empty() || hint.trim().is_empty() {
                return Err("Provide a run and replan hint.");
            }
            Request {
                event: "run:approve",
                body: json!({"runId": run, "none": true, "hint": hint}),
            }
        }
        "read" if valid_path(rest) => Request {
            event: "file:snapshot",
            body: json!({"path": rest}),
        },
        "lock" if valid_path(rest.trim_end_matches('/')) => Request {
            event: "lock:acquire",
            body: json!({"path": rest, "kind": if rest.ends_with('/') { "dir" } else { "file" }}),
        },
        "unlock" if valid_path(rest.trim_end_matches('/')) => Request {
            event: "lock:release",
            body: json!({"path": rest}),
        },
        "git-status" if rest.is_empty() => Request {
            event: "git:status",
            body: json!({}),
        },
        _ => {
            return Err(
                "Commands: run TASK | runs | pause/resume ID | approve ID CANDIDATE | reject ID HINT | read PATH | lock/unlock PATH | git-status",
            );
        }
    };
    Ok(request)
}

fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains(['\\', ':'])
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != ".." && !p.eq_ignore_ascii_case(".git"))
}

#[derive(Default)]
pub struct State {
    pub connected: bool,
    pub owner: String,
    pub input: String,
    pub runs: BTreeMap<String, Run>,
    pub log: VecDeque<String>,
    pub run_scroll: u16,
}

impl State {
    pub fn note(&mut self, text: impl AsRef<str>) {
        // Treat all server output as text, never terminal escape sequences.
        for line in text.as_ref().lines().take(100) {
            let safe: String = line
                .chars()
                .filter(|c| !c.is_control())
                .take(2_000)
                .collect();
            self.log.push_back(safe);
        }
        while self.log.len() > 200 {
            self.log.pop_front();
        }
    }

    pub fn receive(&mut self, event: &str, value: Value) {
        if event == "run:event" {
            if let Ok(run) = serde_json::from_value::<Run>(value["run"].clone()) {
                if value["seq"].as_u64() == Some(run.seq)
                    && value["runId"].as_str() == Some(run.run_id.as_str())
                {
                    self.update_run(run);
                }
            }
        } else if event == "run:list" && value["ok"] == true {
            if let Ok(runs) = serde_json::from_value::<Vec<Run>>(value["runs"].clone()) {
                // A newer event can arrive before an older in-flight list ack.
                // Merge by sequence rather than regressing displayed approval state.
                for run in runs {
                    self.update_run(run);
                }
            }
        } else if event == "room:join" {
            self.connected = value["ok"] == true;
            self.owner = value["self"]["userId"].as_str().unwrap_or("").into();
            self.note(if self.connected {
                "Connected. Type a command; Esc exits."
            } else {
                "Workspace access refused."
            });
        } else if event == "disconnected" {
            self.connected = false;
            self.note("Disconnected. Restart the CLI to reconnect; commands are not replayed.");
        } else {
            self.note(format!("{event}: {value}"));
        }
    }

    fn update_run(&mut self, run: Run) {
        if self
            .runs
            .get(&run.run_id)
            .is_none_or(|old| run.seq > old.seq)
        {
            self.runs.insert(run.run_id.clone(), run);
            // Bound the view; the server remains the source of truth.
            if self.runs.len() > 100 {
                // Completed history must not displace an active approval.
                let victim = self
                    .runs
                    .values()
                    .min_by_key(|r| {
                        (
                            r.state != "done",
                            r.owner_id == self.owner,
                            r.state == "awaiting_approval",
                        )
                    })
                    .map(|r| r.run_id.clone());
                if let Some(id) = victim {
                    self.runs.remove(&id);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_a_task_without_supplying_an_owner() {
        assert_eq!(
            command("run implement sum()"),
            Ok(Request {
                event: "run:start",
                body: json!({"task":"implement sum()"})
            })
        );
    }

    #[test]
    fn approvals_are_explicit_and_unknown_commands_do_not_execute_shell() {
        assert!(command("approve").is_err());
        assert!(command("rm -rf /").is_err());
        assert_eq!(
            command("approve r1 c2").unwrap().body,
            json!({"runId":"r1", "candidateId":"c2"})
        );
        assert!(command("read ../secret").is_err());
    }

    #[test]
    fn ignores_duplicate_stale_and_inconsistent_run_events() {
        let mut s = State::default();
        let event = |seq, state| json!({"runId":"r1", "seq":seq, "run":{"runId":"r1","ownerId":"alice","task":"repair","state":state,"seq":seq,"routerMode":"openai"}});
        s.receive("run:event", event(2, "executing"));
        s.receive("run:event", event(1, "routing"));
        s.receive("run:event", event(2, "done"));
        let mut inconsistent = event(3, "error");
        inconsistent["seq"] = json!(4);
        s.receive("run:event", inconsistent);
        assert_eq!(s.runs["r1"].state, "executing");
    }

    #[test]
    fn log_is_bounded_and_filters_terminal_controls() {
        let mut s = State::default();
        for _ in 0..300 {
            s.note("\x1b[31mHello\x07");
        }
        assert_eq!(s.log.len(), 200);
        assert!(!s.log[0].contains('\x1b'));
    }

    #[test]
    fn snapshot_cannot_roll_back_a_newer_event() {
        let mut state = State::default();
        let run = |seq, status| json!({"runId":"r1","ownerId":"alice","task":"repair","state":status,"seq":seq});
        state.receive(
            "run:event",
            json!({"runId":"r1","seq":3,"run":run(3,"done")}),
        );
        state.receive("run:list", json!({"ok":true,"runs":[run(2,"executing")]}));
        assert_eq!(state.runs["r1"].state, "done");
    }

    #[test]
    fn keeps_owned_approval_when_completed_history_overflows() {
        let mut state = State {
            owner: "alice".into(),
            ..State::default()
        };
        for index in 0..101 {
            state.receive(
                "run:event",
                json!({"runId":format!("{index:03}"),"seq":1,"run":{
                    "runId":format!("{index:03}"),"ownerId":"alice","task":"repair","seq":1,
                    "state":if index == 0 {"awaiting_approval"} else {"done"}
                }}),
            );
        }
        assert_eq!(state.runs.len(), 100);
        assert_eq!(state.runs["000"].state, "awaiting_approval");
    }
}
