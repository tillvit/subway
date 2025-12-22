import express from "express";
import net from "node:net";
import { ConnectionHandler, ConnectionMap, MessageType, serialize } from "./protocol.js";

const REMOTE_PORT = 8198
const WEBSITE_PORT = 6060
const DEBUG = process.env.DEBUG === "true";

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
    connected = false;

    constructor(options) {
        super(options);
        this.retryInterval = options?.retryInterval || this.retryInterval;
        this.onDisconnect = options?.onDisconnect || null;
    }

    connect(port, host, handler) {
        this._connect(port, host, handler);
    }

    _connect(port, host, handler) {
        let timeout = null;
        console.log(`Attempting to connect to ${host}:${port}...`);
        super.connect(port, host, handler);
        super.on('error', (err) => {
            console.error(`Connection error: ${err.message}`);
            this.onDisconnect?.()
            clearTimeout(timeout);
            this.removeAllListeners();
            timeout = setTimeout(() => this._connect(port, host, handler), this.retryInterval);
            this.connected = false;
        })
        super.on('connect', () => {
            clearTimeout(timeout);
            console.log(`Successfully connected to ${host}:${port}`);
            this.connected = true;
        });
        super.on('close', () => {
            console.log(`Connection ended by server.`);
            this.onDisconnect?.()
            clearTimeout(timeout);
            this.removeAllListeners();
            timeout = setTimeout(() => this._connect(port, host, handler), this.retryInterval);
            this.connected = false;
        });
    }
}

const connectionMap = new ConnectionMap();
const connectionTransferData = new Map();
const totalStats = {
    startTime: Date.now(),
    totalConnections: 0,
    totalBytesInbound: 0,
    totalBytesOutbound: 0,
}
const parser = new ConnectionHandler(onPacket)

const remoteClient = new ReconnectingSocket({
    onDisconnect: () => {
        connectionMap.clear();
    }
});

remoteClient.connect(REMOTE_PORT, process.env.REMOTE_HOST, () => {
    console.log(`Connected to server at ${process.env.REMOTE_HOST}:${REMOTE_PORT}`);
    connectionMap.clear();

    // Send authentication token
    const authBuffer = Buffer.from(process.env.AUTH_TOKEN, 'hex');
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
    if (DEBUG) console.log(packet)
    switch (packet.type) {
        case MessageType.CREATE_CONNECTION: {
            const clientSocket = new net.Socket();
            totalStats.totalConnections += 1;
            clientSocket.connect(port, 'localhost', () => {
                console.log(`Connected to local service on port ${port} for mapId ${packet.mapId}`);
            });
            clientSocket.on('data', (chunk) => {
                if (DEBUG) console.log("Local data", chunk)
                connectionTransferData.get(packet.mapId).outbound.packetCount += 1;
                connectionTransferData.get(packet.mapId).outbound.totalBytes += chunk.length;
                totalStats.totalBytesOutbound += chunk.length;
                const message = serialize({
                    type: MessageType.DATA,
                    mapId: packet.mapId,
                    payload: chunk
                });
                remoteClient.write(message);
            })
            clientSocket.on('close', () => {
                connectionMap.close(packet.mapId);
                connectionTransferData.delete(packet.mapId);
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
                connectionTransferData.delete(packet.mapId);
                const closeMessage = serialize({
                    type: MessageType.CLOSE_CONNECTION,
                    mapId: packet.mapId
                });
                remoteClient.write(closeMessage);
            });
            connectionMap.assign(clientSocket, packet.mapId);
            connectionTransferData.set(packet.mapId, {
                outbound: {
                    totalBytes: 0,
                    packetCount: 0,
                },
                inbound: {
                    totalBytes: 0,
                    packetCount: 0,
                },
                startTime: Date.now(),
            });
            break;
        }
        case MessageType.DATA: {
            const clientSocket = connectionMap.get(packet.mapId);
            if (clientSocket) {
                clientSocket.write(packet.payload);
                totalStats.totalBytesInbound += packet.payload.length;
                connectionTransferData.get(packet.mapId).inbound.packetCount += 1;
                connectionTransferData.get(packet.mapId).inbound.totalBytes += packet.payload.length;
            } else {
                console.error(`No local connection found for mapId ${packet.mapId}`);
            }
            break;
        }
        case MessageType.CLOSE_CONNECTION: {
            connectionMap.close(packet.mapId);
            connectionTransferData.delete(packet.mapId);
            break;
        }
    }
}

// if (DEBUG) {
// setInterval(() => {
    // console.log(parser.buffer.length)
    // console.log(parser.buffer.read(parser.buffer.length))
    // for (const [mapId, data] of connectionTransferData.entries()) {
    //     const elapsedTime = (Date.now() - data.startTime) / 1000; // in seconds
    //     console.log(`MapId ${mapId} - Local: ${data.local.totalBytes} bytes in ${data.local.packetCount} packets | Remote: ${data.remote.totalBytes} bytes in ${data.remote.packetCount} packets | Elapsed Time: ${elapsedTime.toFixed(2)}s`);
    // }
// }, 1000)
// }

const app = express()
app.get('/', (req, res) => {
    res.sendFile('./index.html', { root: '.' });
})

app.get('/stats', (req, res) => {
    const connectionStats = [...connectionTransferData.entries()].map(([mapId, data]) => ({
        mapId: mapId,
        ...data
    }));
    res.json({
        totalStats,
        connectionStats,
        connected: remoteClient.connected
    });
})

app.post('/disconnect/:mapId', (req, res) => {
    const mapId = parseInt(req.params.mapId);
    if (isNaN(mapId)) {
        res.status(400).send('Invalid mapId');
        return;
    }
    connectionMap.close(mapId);
    connectionTransferData.delete(mapId);
    const closeMessage = serialize({
        type: MessageType.CLOSE_CONNECTION,
        mapId: mapId
    });
    remoteClient.write(closeMessage);
    res.status(200).send('Disconnected');
})

app.listen(WEBSITE_PORT, () => {
  console.log(`Web server listening on port ${WEBSITE_PORT}`)
})
