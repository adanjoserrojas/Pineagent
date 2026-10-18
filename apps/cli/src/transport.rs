use crate::Request;
use rust_socketio::{ClientBuilder, Payload, client::Client};
use serde_json::{Value, json};
use std::{
    sync::mpsc::{self, Receiver, SyncSender},
    time::Duration,
};
use url::Url;

pub struct Config {
    pub endpoint: String,
    pub workspace: String,
    pub branch: String,
    pub token: String,
}

impl Config {
    pub fn validate(&self) -> Result<(), &'static str> {
        let url = Url::parse(&self.endpoint).map_err(|_| "Invalid backend URL")?;
        let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !(url.scheme() == "https" || (local && url.scheme() == "http"))
        {
            return Err(
                "Use HTTPS (HTTP permitted only on loopback); no URL credentials, query or fragment.",
            );
        }
        if self.workspace.is_empty() || self.branch.is_empty() || self.token.trim().is_empty() {
            return Err("Workspace, branch and a session token file are required.");
        }
        Ok(())
    }
}

fn unpack(payload: Payload) -> Value {
    match payload {
        Payload::Text(mut values) if values.len() == 1 => values.remove(0),
        _ => json!({"ok":false,"code":"INVALID_RESPONSE"}),
    }
}

fn unpack_ack(payload: Payload) -> Value {
    // rust_socketio wraps the raw acknowledgement argument array in Text;
    // ordinary events already arrive as individual values.
    match unpack(payload) {
        Value::Array(mut args) if args.len() == 1 && args[0].is_object() => args.remove(0),
        value if value.is_object() => value,
        _ => json!({"ok":false,"code":"INVALID_RESPONSE"}),
    }
}

pub fn request(client: &Client, event: &'static str, body: Value) -> Result<Value, &'static str> {
    let (tx, rx) = mpsc::sync_channel(1);
    client
        .emit_with_ack(event, body, Duration::from_secs(8), move |payload, _| {
            let _ = tx.try_send(unpack_ack(payload));
        })
        .map_err(|_| "Backend connection failed")?;
    rx.recv_timeout(Duration::from_secs(9))
        .map_err(|_| "No acknowledgement; request outcome unknown. Refresh before retrying.")
}

pub struct Session {
    client: Client,
    pub joined: Value,
}

pub type Update = (&'static str, Value);

impl Session {
    pub fn connect(config: Config, updates: SyncSender<Update>) -> Result<Self, &'static str> {
        config.validate()?;
        let events = updates.clone();
        let closed = updates.clone();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let failed_tx = ready_tx.clone();
        let client = ClientBuilder::new(config.endpoint)
            .auth(json!({"token": config.token.trim()}))
            // Never replay writes or retain a stale room across reconnects.
            .reconnect(false)
            // connect() starts Engine.IO but does not wait for Socket.IO auth.
            .on("open", move |_, _| {
                let _ = ready_tx.try_send(true);
            })
            .on("run:event", move |payload, _| {
                let _ = events.try_send(("run:event", unpack(payload)));
            })
            .on("close", move |_, _| {
                let _ = closed.try_send(("disconnected", Value::Null));
            })
            .on("error", move |_, _| {
                let _ = failed_tx.try_send(false);
                let _ = updates.try_send(("disconnected", Value::Null));
            })
            .connect()
            .map_err(|_| "Unable to authenticate/connect to the backend")?;
        if ready_rx.recv_timeout(Duration::from_secs(9)) != Ok(true) {
            let _ = client.disconnect();
            return Err("Backend authentication failed or timed out");
        }
        let joined = match request(
            &client,
            "room:join",
            json!({"wsId":config.workspace,"branch":config.branch}),
        ) {
            Ok(joined) => joined,
            Err(error) => {
                let _ = client.disconnect();
                return Err(error);
            }
        };
        if joined["ok"] != true {
            let _ = client.disconnect();
            return Err("Workspace access refused");
        }
        Ok(Self { client, joined })
    }

    pub fn call(&self, req: Request) -> Result<Value, &'static str> {
        request(&self.client, req.event, req.body)
    }

    pub fn serve(self, commands: Receiver<Request>, updates: SyncSender<Update>) {
        let heartbeat = self.joined["timing"]["heartbeatMs"]
            .as_u64()
            .unwrap_or(10_000)
            .clamp(100, 10_000);
        let _ = updates.send(("room:join", self.joined.clone()));
        // Lease renewal must not queue behind a slow command or run-list ack.
        let (stop_tx, stop_rx) = mpsc::channel();
        let heartbeat_client = self.client.clone();
        let heartbeat_updates = updates.clone();
        let renewal = std::thread::spawn(move || {
            while matches!(
                stop_rx.recv_timeout(Duration::from_millis(heartbeat)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ) {
                if !matches!(request(&heartbeat_client, "session:heartbeat", json!({})), Ok(ack) if ack["ok"] == true)
                {
                    let _ = heartbeat_updates.try_send(("disconnected", Value::Null));
                    let _ = heartbeat_client.disconnect();
                    break;
                }
            }
        });
        let mut beat = std::time::Instant::now();
        let refresh = || {
            if let Ok(runs) = request(&self.client, "run:list", json!({})) {
                let _ = updates.try_send(("run:list", runs));
            }
        };
        refresh();
        loop {
            match commands.recv_timeout(Duration::from_millis(100)) {
                Ok(req) => {
                    let event = req.event;
                    let response = self
                        .call(req)
                        .unwrap_or_else(|message| json!({"ok":false,"message":message}));
                    if updates.send((event, response)).is_err() {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if beat.elapsed() >= Duration::from_millis(heartbeat) {
                refresh(); // Reconcile event loss/overflow using the authoritative snapshot.
                beat = std::time::Instant::now();
            }
        }
        let _ = stop_tx.send(());
        let _ = renewal.join();
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.client.disconnect();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decodes_the_librarys_raw_ack_envelope_separately_from_events() {
        let ack = Payload::from(r#"[{"ok":true,"runId":"r1"}]"#);
        assert_eq!(unpack_ack(ack), json!({"ok":true,"runId":"r1"}));
        let event = Payload::Text(vec![json!({"runId":"r1"})]);
        assert_eq!(unpack(event), json!({"runId":"r1"}));
    }
    #[test]
    fn refuses_to_send_tokens_to_plaintext_remote_hosts() {
        let mut c = Config {
            endpoint: "http://example.com".into(),
            workspace: "owner/repo".into(),
            branch: "main".into(),
            token: "fake".into(),
        };
        assert!(c.validate().is_err());
        c.endpoint = "https://example.com".into();
        assert!(c.validate().is_ok());
        c.endpoint = "http://localhost:3001".into();
        assert!(c.validate().is_ok());
        c.endpoint = "https://user:secret@example.com".into();
        assert!(c.validate().is_err());
    }
}
