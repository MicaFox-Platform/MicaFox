# Test-only TLS fixture

`cert.pem` and `key.pem` are a self-signed certificate for `localhost` and `127.0.0.1`, valid for 100 years, used
only by the connector's tests. The key protects nothing: it is public by design.
