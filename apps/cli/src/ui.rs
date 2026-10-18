use crate::State;
use ratatui::{
    Frame,
    layout::{Constraint, Layout},
    style::{Color, Style},
    widgets::{Block, Paragraph, Wrap},
};

pub fn draw(frame: &mut Frame, state: &State, workspace: &str, branch: &str) {
    if frame.area().height < 10 || frame.area().width < 30 {
        frame.render_widget(
            Paragraph::new("Pineagent\nEnlarge terminal\nEsc exits").wrap(Wrap { trim: false }),
            frame.area(),
        );
        return;
    }
    let areas = Layout::vertical([
        Constraint::Length(3),
        Constraint::Percentage(45),
        Constraint::Min(3),
        Constraint::Length(3),
    ])
    .split(frame.area());
    frame.render_widget(
        Paragraph::new(format!(
            "Pineagent | {workspace} @ {branch} | {}",
            if state.connected {
                "connected"
            } else {
                "disconnected"
            }
        ))
        .style(Style::default().fg(if state.connected {
            Color::Green
        } else {
            Color::Yellow
        }))
        .block(Block::bordered()),
        areas[0],
    );
    let mut lines = Vec::new();
    for run in state.runs.values() {
        let who = if run.owner_id == state.owner {
            "you"
        } else {
            &run.owner_id
        };
        lines.push(format!(
            "{} [{}] {} | router={} recovery={}",
            run.run_id,
            who,
            run.state,
            run.router_mode.as_deref().unwrap_or("pending"),
            run.coding_recovery.as_deref().unwrap_or("none")
        ));
        lines.push(format!("  {}", run.task));
        lines.push(format!("  writes: {}", run.write_set.join(", ")));
        if let Some(error) = &run.error {
            lines.push(format!("  error: {error}"));
        }
        if let Some(blocked) = &run.blocked_on {
            lines.push(format!("  blocked: {blocked}"));
        }
        for step in &run.steps {
            lines.push(format!("  {}: {}", step["tool"], step["detail"]));
        }
        if run.state == "awaiting_approval" {
            for candidate in &run.candidates {
                lines.push(format!(
                    "  candidate={} score={}",
                    candidate["id"], candidate["score"]
                ));
                if let Some(steps) = candidate["steps"].as_array() {
                    for step in steps {
                        lines.push(format!(
                            "    {}: {} | writes={}",
                            step["tool"], step["detail"], step["writes"]
                        ));
                    }
                }
            }
        }
    }
    if lines.is_empty() {
        lines.push("No runs. Use: run TASK".into());
    }
    frame.render_widget(
        Paragraph::new(lines.join("\n"))
            .wrap(Wrap { trim: false })
            .scroll((state.run_scroll, 0))
            .block(Block::bordered().title(" Runs / PgUp PgDn scroll / Home resets ")),
        areas[1],
    );
    let height = areas[2].height.saturating_sub(2) as usize;
    let log = state
        .log
        .iter()
        .skip(state.log.len().saturating_sub(height))
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");
    frame.render_widget(
        Paragraph::new(log)
            .wrap(Wrap { trim: false })
            .block(Block::bordered().title(" Results / Esc exits / type help for commands ")),
        areas[2],
    );
    frame.render_widget(
        Paragraph::new(format!("> {}", state.input)).block(Block::bordered().title(" Command ")),
        areas[3],
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{Terminal, backend::TestBackend};
    #[test]
    fn renders_status_and_command_input_at_small_and_large_sizes() {
        for (width, height) in [(40, 12), (100, 30), (10, 5)] {
            let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
            terminal
                .draw(|f| draw(f, &State::default(), "owner/repo", "main"))
                .unwrap();
            assert!(
                terminal
                    .backend()
                    .buffer()
                    .content()
                    .iter()
                    .any(|cell| cell.symbol() == "P")
            );
        }
    }

    #[test]
    fn approval_view_shows_the_candidate_actions_and_writes() {
        let mut state = State::default();
        state.receive("run:list", serde_json::json!({"ok":true,"runs":[{
            "runId":"r1","ownerId":"alice","task":"repair sum","state":"awaiting_approval","seq":1,
            "candidates":[{"id":"targeted","score":0.8,"steps":[{"tool":"read_file","detail":"inspect source","writes":["src/sum.js"]}]}]
        }]}));
        let mut terminal = Terminal::new(TestBackend::new(120, 40)).unwrap();
        terminal
            .draw(|f| draw(f, &state, "owner/repo", "main"))
            .unwrap();
        let text: String = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        for expected in ["targeted", "0.8", "read_file", "src/sum.js"] {
            assert!(text.contains(expected), "missing {expected}");
        }
    }
}
