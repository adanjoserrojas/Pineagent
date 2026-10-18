use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use pineagent_cli::{
    State, command,
    transport::{Config, Session},
    ui,
};
use std::{
    env, fs,
    io::{self, IsTerminal},
    sync::mpsc,
    time::Duration,
};

fn main() {
    if let Err(message) = run() {
        eprintln!("Pineagent: {message}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.iter().any(|s| s == "--help" || s == "-h") {
        println!(
            "Pineagent workspace CLI\nEnvironment: PINEAGENT_URL (HTTPS), PINEAGENT_WORKSPACE, PINEAGENT_BRANCH, PINEAGENT_TOKEN_FILE\nRun with no arguments for the terminal UI. --check verifies login and lists runs.\n--command 'run TASK' sends one command and exits. No AWS/model credentials are used."
        );
        return Ok(());
    }
    let check = args == ["--check"];
    let single = if args.len() == 2 && args[0] == "--command" {
        Some(command(&args[1])?)
    } else {
        None
    };
    if !args.is_empty() && !check && single.is_none() {
        return Err("Unknown arguments; use --help".into());
    }
    if !check && single.is_none() && (!io::stdin().is_terminal() || !io::stdout().is_terminal()) {
        return Err("Interactive mode requires a terminal; use --check or --command".into());
    }
    let workspace = env::var("PINEAGENT_WORKSPACE").map_err(|_| "Set PINEAGENT_WORKSPACE")?;
    let branch = env::var("PINEAGENT_BRANCH").unwrap_or_else(|_| "main".into());
    let token_file = env::var("PINEAGENT_TOKEN_FILE")
        .map_err(|_| "Set PINEAGENT_TOKEN_FILE to your private backend session-token file")?;
    let token = fs::read_to_string(token_file).map_err(|_| "Cannot read session token file")?;
    let config = Config {
        endpoint: env::var("PINEAGENT_URL").map_err(|_| "Set PINEAGENT_URL")?,
        workspace: workspace.clone(),
        branch: branch.clone(),
        token,
    };
    let (updates_tx, updates_rx) = mpsc::sync_channel(32);
    let session = Session::connect(config, updates_tx.clone())?;
    if check || single.is_some() {
        let response = session.call(single.unwrap_or(command("runs")?))?;
        println!("{}", serde_json::to_string(&response)?);
        if response["ok"] != true {
            return Err("Backend refused the request".into());
        }
        return Ok(());
    }
    let (commands_tx, commands_rx) = mpsc::sync_channel(8);
    let worker = std::thread::spawn(move || session.serve(commands_rx, updates_tx));
    let mut state = State::default();
    state.note("Connecting to workspace…");
    let mut terminal = ratatui::init();
    let result = (|| -> io::Result<()> {
        loop {
            for (event, payload) in updates_rx.try_iter() {
                state.receive(event, payload);
            }
            terminal.draw(|f| ui::draw(f, &state, &workspace, &branch))?;
            if event::poll(Duration::from_millis(50))? {
                if let Event::Key(key) = event::read()? {
                    if key.kind != KeyEventKind::Press {
                        continue;
                    }
                    match key.code {
                        KeyCode::Esc => break,
                        KeyCode::PageDown => state.run_scroll = state.run_scroll.saturating_add(5),
                        KeyCode::PageUp => state.run_scroll = state.run_scroll.saturating_sub(5),
                        KeyCode::Home => state.run_scroll = 0,
                        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                            break;
                        }
                        KeyCode::Enter => match command(&state.input) {
                            Ok(req) if state.connected => {
                                if commands_tx.try_send(req).is_err() {
                                    state.note("Command queue busy; not submitted.");
                                } else {
                                    state.input.clear();
                                }
                            }
                            Ok(_) => state.note("Not connected; nothing submitted."),
                            Err(message) => state.note(message),
                        },
                        KeyCode::Backspace => {
                            state.input.pop();
                        }
                        KeyCode::Char(c) if !c.is_control() && state.input.len() < 8_000 => {
                            state.input.push(c)
                        }
                        _ => {}
                    }
                }
            }
        }
        Ok(())
    })();
    ratatui::restore();
    drop(commands_tx);
    drop(updates_rx);
    let _ = worker.join();
    result?;
    Ok(())
}
