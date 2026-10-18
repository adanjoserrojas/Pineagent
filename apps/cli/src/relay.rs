// Optional container transport; the original Socket.IO client and UI stay intact.
#[cfg(unix)]
pub fn endpoint(path: &str) -> Result<String, Box<dyn std::error::Error>> {
    use std::{
        net::TcpListener,
        os::unix::net::UnixStream,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        thread,
    };
    if !path.starts_with('/') {
        return Err("Expected an absolute private relay socket".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let address = listener.local_addr()?;
    let path = path.to_owned();
    let active = Arc::new(AtomicUsize::new(0));
    thread::spawn(move || {
        for incoming in listener.incoming() {
            let Ok(mut tcp) = incoming else { break };
            if active.fetch_add(1, Ordering::SeqCst) >= 16 {
                active.fetch_sub(1, Ordering::SeqCst);
                continue;
            }
            let path = path.clone();
            let active = active.clone();
            thread::spawn(move || {
                let _ = (|| -> std::io::Result<()> {
                    let mut unix = UnixStream::connect(path)?;
                    let mut tcp_read = tcp.try_clone()?;
                    let mut unix_write = unix.try_clone()?;
                    let upstream = thread::spawn(move || {
                        let _ = std::io::copy(&mut tcp_read, &mut unix_write);
                        let _ = unix_write.shutdown(std::net::Shutdown::Write);
                    });
                    let _ = std::io::copy(&mut unix, &mut tcp);
                    let _ = tcp.shutdown(std::net::Shutdown::Both);
                    let _ = unix.shutdown(std::net::Shutdown::Both);
                    let _ = upstream.join();
                    Ok(())
                })();
                active.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });
    Ok(format!("http://{address}"))
}

#[cfg(not(unix))]
pub fn endpoint(_: &str) -> Result<String, Box<dyn std::error::Error>> {
    Err("The isolated terminal relay requires Linux".into())
}

#[cfg(all(test, unix))]
mod tests {
    #[test]
    fn forwards_bidirectional_bytes_through_the_private_socket() {
        use std::{
            io::{Read, Write},
            net::TcpStream,
            os::unix::net::UnixListener,
        };
        let path =
            std::env::temp_dir().join(format!("pineagent-relay-{}.sock", std::process::id()));
        let listener = UnixListener::bind(&path).unwrap();
        let peer = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = [0; 4];
            stream.read_exact(&mut bytes).unwrap();
            assert_eq!(&bytes, b"ping");
            stream.write_all(b"pong").unwrap();
        });
        let endpoint = super::endpoint(path.to_str().unwrap()).unwrap();
        let mut client = TcpStream::connect(endpoint.trim_start_matches("http://")).unwrap();
        client.write_all(b"ping").unwrap();
        let mut bytes = [0; 4];
        client.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"pong");
        drop(client);
        peer.join().unwrap();
        std::fs::remove_file(path).unwrap();
    }
}
