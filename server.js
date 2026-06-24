import { ArgumentParser } from "argparse";
import { readFileSync } from "fs";
import net from "net";
import { ConnectionHandler, ConnectionMap, MessageType, serialize } from "./protocol.js";

const EXPOSE_PORT = 8199
const REMOTE_PORT = 8198

const argparse = new ArgumentParser({
    description: 'Subway Server'
});

argparse.add_argument('-e', '--exposeport', { help: 'Port to expose', type: 'int' });
argparse.add_argument('-p', '--remoteport', { help: 'The designated remote port', type: 'int' });
argparse.add_argument('-d', '--debug', { help: 'Enable debug mode', action: 'store_true' });
argparse.add_argument('config', { help: 'Path to the configuration file' });

const args = argparse.parse_args();

let config = {
    debug: false,
}
const spec = [
    { key: 'remote_port', type: 'int' },
    { key: 'expose_port', type: 'int' },
    { key: 'auth_token', type: 'string' },
    { key: 'debug', type: 'boolean' },
]

if (args.config) {
    try {
        const parsed = JSON.parse(readFileSync(args.config, 'utf-8'))

        for (const { key, type } of spec) {
            if (key in parsed) {
                const value = parsed[key];
                switch (type) {
                    case 'string':
                        if (typeof value !== 'string') {
                            throw new Error(`Expected ${key} to be a string`)
                        }
                        break;
                    case 'int':
                        if (typeof value !== 'number' || !Number.isInteger(value)) {
                            throw new Error(`Expected ${key} to be an integer`)
                        }
                        break;
                    case 'boolean':
                        if (typeof value !== 'boolean') {
                            throw new Error(`Expected ${key} to be a boolean`)
                        }
                        break;
                    default:
                        throw new Error(`Unknown type for key ${key}: ${type}`)
                }
                config[key] = value
            }
        }
    } catch (e) {
        console.error(`Error parsing config file: ${e.message}`)
        process.exit(1)
    }
}
if (args.exposeport) config.expose_port = args.exposeport
if (args.remoteport) config.remote_port = args.remoteport
if (args.authtoken) config.auth_token = args.authtoken
if (args.debug) config.debug = args.debug

for (const { key, type } of spec) {
    if (!(key in config)) {
        console.error(`Missing required configuration key: ${key}`)
        process.exit(1)
    }
}

// check if expose_port is a valid port number
if (config.expose_port < 1 || config.expose_port > 65535) {
    console.error(`Invalid expose_port: ${config.expose_port}. It should be between 1 and 65535.`)
    process.exit(1)
}

// check if remote_port is a valid port number
if (config.remote_port < 1 || config.remote_port > 65535) {
    console.error(`Invalid remote_port: ${config.remote_port}. It should be between 1 and 65535.`)
    process.exit(1)
}

// check format of auth_token
if (!/^[0-9a-fA-F]+$/.test(config.auth_token) && config.auth_token.length != 32) {
    console.error(`Invalid auth_token format. It should be a hexadecimal string of length 32 (16 bytes).`)
    process.exit(1)
}

console.log(`Tunnel: REMOTE localhost:${config.remote_port} <-> EXPOSE localhost:${config.expose_port}`)


let remoteSocket = null

const connectionMap = new ConnectionMap()

function buf2hex(buffer) {
    return [...new Uint8Array(buffer)]
        .map(x => x.toString(16).padStart(2, '0'))
        .join('');
}

const exposeServer = net.createServer((socket) => {
    if (!remoteSocket) {
        console.warn("No remote socket connected. Closing expose connection.")
        socket.destroy()
        return
    }
    socket.setKeepAlive(true, 5000)
    console.log(`Client connected to expose server from ${socket.remoteAddress}:${socket.remotePort}`)
    const mapId = connectionMap.assign(socket)

    remoteSocket.write(serialize({
        type: MessageType.CREATE_CONNECTION,
        mapId: mapId
    }))

    socket.on("close", () => {
        connectionMap.close(mapId)
        console.log(`Expose client disconnected for mapId ${mapId}`)
        if (!remoteSocket)
            console.warn("Couldn't write data to remote socket!")
        remoteSocket?.write(serialize({
            type: MessageType.CLOSE_CONNECTION,
            mapId: mapId
        }))
    })

    socket.on("data", (data) => {
        console.log(`Received from client: `, data)
        if (!remoteSocket)
            console.warn("Couldn't write data to remote socket!")
        remoteSocket?.write(serialize({
            type: MessageType.DATA,
            mapId: mapId,
            payload: data
        }))
    })
    socket.on("error", (err) => {
        console.error("Expose socket error:", err)
        if (!remoteSocket)
            console.warn("Couldn't write data to remote socket!")
        connectionMap.close(mapId)
        remoteSocket?.write(serialize({
            type: MessageType.CLOSE_CONNECTION,
            mapId: mapId
        }))
    })
})


const remoteServer = net.createServer((socket) => {
    socket.setKeepAlive(true, 5000)
    console.log(`Client connected to remote server from ${socket.remoteAddress}:${socket.remotePort}`)
    const authTimeout = setTimeout(() => {
        console.log("Client failed to authenticate in time. Disconnecting.")
        socket.destroy()
    }, 10000) // 10 seconds to authenticate

    const parser = new ConnectionHandler(onPacket)

    if (config.debug) {
        const parserDebugInterval = setInterval(() => {
            console.log(parser.buffer.length)
            console.log(parser.buffer.read(parser.buffer.length))
        }, 1000);
    }

    function onPacket(packet) {
        switch (packet.type) {
            case MessageType.AUTH: // AUTHENTICATE
                const receivedToken = buf2hex(packet.authToken)
                if (receivedToken === config.auth_token) {
                    remoteSocket = socket;
                    clearTimeout(authTimeout);
                    console.log("Client authenticated successfully.");
                    remoteSocket.write(serialize({ type: MessageType.AUTH_OK }))
                } else {
                    console.warn("Client failed to authenticate. Disconnecting.");
                    socket.destroy();
                }
                break

            case MessageType.DATA: // DATA
                if (socket !== remoteSocket) {
                    console.warn("Received data before authentication. Ignoring.");
                    socket.destroy();
                }
                const clientSocket = connectionMap.get(packet.mapId);
                clientSocket?.write(packet.payload)
                break;

            case MessageType.CLOSE_CONNECTION: // CLOSE_CONNECTION
                if (socket !== remoteSocket) {
                    console.warn("Received data before authentication. Ignoring.")
                    socket.destroy()
                }
                clearInterval(parserDebugInterval)
                connectionMap.close(packet.mapId)
                break
        }
    }

    socket.on("data", (data) => {
        void parser.push(data);
    })

    socket.on("error", (err) => {
        console.error("Remote socket error:", err)
        if (socket === remoteSocket) {
            remoteSocket = null;
            connectionMap.clear();
            console.warn(`Remote socket disconnected due to error.`);
        }
        socket.destroy()
        clearInterval(parserDebugInterval);
    })

    socket.on("close", () => {
        if (socket === remoteSocket) {
            remoteSocket = null;
            connectionMap.clear();
            console.warn(`Remote socket disconnected.`);
        }
        socket.destroy()
        clearInterval(parserDebugInterval);
    })
})

exposeServer.listen(config.expose_port, () => {
    console.log(`Expose server listening on port ${config.expose_port}`)
})
remoteServer.listen(config.remote_port, () => {
    console.log(`Remote server listening on port ${config.remote_port}`)
})
