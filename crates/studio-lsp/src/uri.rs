//! `file://` URI conversion.

use std::path::{Path, PathBuf};

fn encode_byte(b: u8, out: &mut String) {
    if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) {
        out.push(b as char);
    } else {
        out.push_str(&format!("%{b:02X}"));
    }
}

/// Converts an absolute path into a `file://` URI.
pub fn path_to_uri(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    let mut out = String::from("file://");
    if !s.starts_with('/') {
        // Windows drive path: file:///C:/...
        out.push('/');
        let mut chars = s.chars();
        if let (Some(d), Some(':')) = (chars.next(), chars.next()) {
            out.push(d);
            out.push(':');
            for b in chars.as_str().bytes() {
                encode_byte(b, &mut out);
            }
            return out;
        }
    }
    for b in s.bytes() {
        encode_byte(b, &mut out);
    }
    out
}

/// Converts a `file://` URI into a path. Returns `None` for other schemes.
pub fn uri_to_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    // Drop an authority ("localhost") if present.
    let rest = match rest.find('/') {
        Some(0) => rest,
        Some(i) => &rest[i..],
        None => return None,
    };
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    let s = String::from_utf8_lossy(&out).into_owned();
    // "/C:/x" on Windows.
    let b = s.as_bytes();
    if b.len() >= 3 && b[0] == b'/' && b[2] == b':' && b[1].is_ascii_alphabetic() {
        return Some(PathBuf::from(&s[1..]));
    }
    Some(PathBuf::from(s))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let p = Path::new("/home/u/my project/src/ä#1.ts");
        let uri = path_to_uri(p);
        assert_eq!(uri, "file:///home/u/my%20project/src/%C3%A4%231.ts");
        assert_eq!(uri_to_path(&uri).unwrap(), p);
        assert_eq!(
            uri_to_path("file:///C:/x/y.rs").unwrap(),
            PathBuf::from("C:/x/y.rs")
        );
        assert_eq!(
            path_to_uri(Path::new("C:\\x\\y z.rs")),
            "file:///C:/x/y%20z.rs"
        );
        assert_eq!(
            uri_to_path("file://localhost/tmp/a").unwrap(),
            PathBuf::from("/tmp/a")
        );
        assert!(uri_to_path("untitled:1").is_none());
    }
}
