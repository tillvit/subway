import net from "net";
import { ConnectionHandler, ConnectionMap, MessageType, serialize } from "./protocol.js";

const EXPOSE_PORT = 8199
const REMOTE_PORT = 8198

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
    console.log(`Client connected to expose server from ${socket.remoteAddress}:${socket.remotePort}`)
    const mapId = connectionMap.assign(socket)

    remoteSocket.write(serialize({
        type: MessageType.CREATE_CONNECTION,
        mapId: mapId
    }))

    socket.on("close", () => {
        connectionMap.close(mapId)
        remoteSocket?.write(serialize({
            type: MessageType.CLOSE_CONNECTION,
            mapId: mapId
        }))
        console.log(`Expose client disconnected for mapId ${mapId}`)
    })

    socket.on("data", (data) => {
        console.log(`Received from client: `, data)
        remoteSocket?.write(serialize({
            type: MessageType.DATA,
            mapId: mapId,
            payload: data
        }))
    })
    socket.on("error", (err) => {
        console.error("Expose socket error:", err)
        connectionMap.close(mapId)
        remoteSocket?.write(serialize({
            type: MessageType.CLOSE_CONNECTION,
            mapId: mapId
        }))
    })
})


const remoteServer = net.createServer((socket) => {
    console.log(`Client connected to remote server from ${socket.remoteAddress}:${socket.remotePort}`)
    const authTimeout = setTimeout(() => {
        console.log("Client failed to authenticate in time. Disconnecting.")
        socket.destroy()
    }, 10000) // 10 seconds to authenticate

    const parser = new ConnectionHandler(onPacket)

    const parserDebugInterval = setInterval(() => {
        console.log(parser.buffer.length)
        console.log(parser.buffer.read(parser.buffer.length))
    }, 1000);

    function onPacket(packet) {
        switch (packet.type) {
            case MessageType.AUTH: // AUTHENTICATE
                const receivedToken = buf2hex(packet.authToken)
                if (receivedToken === process.env.AUTH_TOKEN) {
                    remoteSocket = socket;
                    clearTimeout(authTimeout);
                    console.log("Client authenticated successfully.");
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

exposeServer.listen(EXPOSE_PORT, () => {
    console.log(`Expose server listening on port ${EXPOSE_PORT}`)
})
remoteServer.listen(REMOTE_PORT, () => {
    console.log(`Remote server listening on port ${REMOTE_PORT}`)
})
