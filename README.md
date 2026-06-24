# subway
Simple TCP tunnel for exposing local ports to a remote IP without using ngrok.

The hoster connects to the tunnel server via the remote port and clients connect via the expose port.

## Running the server

Create a `config.json` file specifying the following fields:
```json
{
  "remote_port": 8198, // remote port of the tunnel server
  "expose_port": 8199, // expoes port of the tunnel server
  "auth_token": "", // auth token used on the tunnel server (32 chars hex, 16 bytes)
  "debug": false // enable debugging
}
```

Then, run ``node server.js config.json`` to start the server. You can override the options defined in the config by viewing the CLI options.

Alternatively, if your config is located at `config.json`, you can run `docker compose up` to run the server as a Docker container.


## Running the client

Create a `config.json` file specifying the following fields:
```json
{
  "remote_host": "", // hostname of the tunnel server
  "remote_port": 8198, // remote port of the tunnel server
  "auth_token": "", // auth token used on the tunnel server (32 chars hex, 16 bytes)
  "webport": 6060, // the port to host the local web viewer on (defaults to 6060)
  "local_port": 56565, // the port of the local service to tunnel to
  "debug": false // enable debugging
}
```

Then, run ``node client.js config.json`` to start the client. You can override the options defined in the config by viewing the CLI options.

