# subway
Simple TCP tunnel for exposing local ports to a remote IP without using ngrok.

### Usage
Create a `.env` file specifying the following fields:
```env
AUTH_TOKEN=...
REMOTE_HOST=...
```
where
- `AUTH_TOKEN` are the authentication bytes required by the server on client connect.
- `REMOTE_HOST` is the hostname of the server.

Run
```bash
npm run server
```
to start the server, and
```bash
npm run client [port]
```
to start forwarding packets to local port `port`.
