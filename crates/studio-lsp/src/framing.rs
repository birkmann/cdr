//! `Content-Length` framing of JSON-RPC messages (LSP base protocol).

use std::io::{self, BufRead, Write};

use serde_json::Value;

/// Writes one framed message.
pub fn write_message(w: &mut impl Write, body: &[u8]) -> io::Result<()> {
    write!(w, "Content-Length: {}\r\n\r\n", body.len())?;
    w.write_all(body)?;
    w.flush()
}

/// Reads one framed message body. Returns `Ok(None)` at end of stream.
///
/// Lines before the header block that are not `Name: value` headers (stray
/// output some servers print to stdout) are skipped.
pub fn read_message(r: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut length: Option<usize> = None;
    let mut line = String::new();
    loop {
        line.clear();
        if r.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        let l = line.trim_end_matches(['\r', '\n']);
        if l.is_empty() {
            if length.is_some() {
                break;
            }
            continue;
        }
        if let Some((name, value)) = l.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().ok();
            }
        }
    }
    let len = length.unwrap_or(0);
    let mut body = vec![0u8; len];
    r.read_exact(&mut body)?;
    Ok(Some(body))
}

/// Reads one message and parses it as JSON. Invalid JSON yields `Value::Null`.
pub fn read_json(r: &mut impl BufRead) -> io::Result<Option<Value>> {
    Ok(read_message(r)?.map(|b| serde_json::from_slice(&b).unwrap_or(Value::Null)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_skips_noise() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"some stray log line\n");
        write_message(&mut buf, br#"{"a":1}"#).unwrap();
        buf.extend_from_slice(b"Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n");
        write_message(&mut buf, "{\"b\":\"\u{e9}\"}".as_bytes()).unwrap();
        let mut r = std::io::Cursor::new(buf);
        assert_eq!(read_json(&mut r).unwrap().unwrap()["a"], 1);
        assert_eq!(read_json(&mut r).unwrap().unwrap()["b"], "\u{e9}");
        assert!(read_json(&mut r).unwrap().is_none());
    }
}
