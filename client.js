import net from "node:net";
import { ConnectionHandler, ConnectionMap, MessageType, serialize } from "./protocol.js";

const REMOTE_SERVER = "ctf.b01lers.com"
const REMOTE_PORT = 8198
const auth = "53c4b0ea24158fa16066817775d73413"

let port;

try {
    port = parseInt(process.argv[2])
} catch (e) {
    console.error(`Usage: node client.js <port>`)
    process.exit(1)
}
if (isNaN(port)) {
    console.error(`Usage: node client.js <port>`)
    process.exit(1)
}


class ReconnectingSocket extends net.Socket {
    retryInterval = 5000; // 5 seconds
    onDisconnect = null;

    constructor(options) {
        super(options);
        this.retryInterval = options?.retryInterval || this.retryInterval;
        this.onDisconnect = options?.onDisconnect || null;
    }

    connect(port, host, handler) {
        let timeout = null;
        const attemptConnection = () => {
            console.log(`Attempting to connect to ${host}:${port}...`);
            super.connect(port, host, handler);
        };
        super.on('error', (err) => {
            console.error(`Connection error: ${err.message}`);
            this.onDisconnect?.()
            timeout = setTimeout(attemptConnection, this.retryInterval);
        })
        super.on('connect', () => {
            clearTimeout(timeout);
            console.log(`Successfully connected to ${host}:${port}`);
        });
        super.on('close', () => {
            console.log(`Connection ended by server.`);
            this.onDisconnect?.()
            timeout = setTimeout(attemptConnection, this.retryInterval);
        });
        attemptConnection();
    }
}

const connectionMap = new ConnectionMap();
const parser = new ConnectionHandler(onPacket)

const remoteClient = new ReconnectingSocket({
    onDisconnect: () => {
        connectionMap.clear();
    }
});

remoteClient.connect(REMOTE_PORT, REMOTE_SERVER, () => {
    console.log(`Connected to server at ${REMOTE_SERVER}:${REMOTE_PORT}`);
    connectionMap.clear();
    // Send authentication token
    const authBuffer = Buffer.from(auth, 'hex');
    const authPacket = serialize({
        type: MessageType.AUTH,
        authToken: authBuffer
    })
    remoteClient.write(authPacket);
})

remoteClient.on("data", (data) => {
    void parser.push(data)
})

function onPacket(packet) {
    console.log(packet)
    switch (packet.type) {
        case MessageType.CREATE_CONNECTION: {
            const clientSocket = new net.Socket();
            clientSocket.connect(port, 'localhost', () => {
                console.log(`Connected to local service on port ${port} for mapId ${packet.mapId}`);
            });
            clientSocket.on('data', (chunk) => {
                console.log("Local data", chunk)
                const message = serialize({
                    type: MessageType.DATA,
                    mapId: packet.mapId,
                    payload: chunk
                });
                remoteClient.write(message);
            })
            clientSocket.on('close', () => {
                connectionMap.close(packet.mapId);
                const closeMessage = serialize({
                    type: MessageType.CLOSE_CONNECTION,
                    mapId: packet.mapId
                });
                console.log(`Local connection closed for mapId ${packet.mapId}`);
                remoteClient.write(closeMessage);
            });
            clientSocket.on('error', (err) => {
                console.error(`Local socket error for mapId ${packet.mapId}:`, err);
                connectionMap.close(packet.mapId);
                const closeMessage = serialize({
                    type: MessageType.CLOSE_CONNECTION,
                    mapId: packet.mapId
                });
                remoteClient.write(closeMessage);
            });
            connectionMap.assign(clientSocket, packet.mapId);
            break;
        }
        case MessageType.DATA: {
            const clientSocket = connectionMap.get(packet.mapId);
            if (clientSocket) {
                clientSocket.write(packet.payload);
            } else {
                console.error(`No local connection found for mapId ${packet.mapId}`);
            }
            break;
        }
        case MessageType.CLOSE_CONNECTION: {
            connectionMap.close(packet.mapId);
            break;
        }
    }
}

setInterval(() => {
    console.log(parser.buffer.length)
    console.log(parser.buffer.read(parser.buffer.length))
}, 1000);
