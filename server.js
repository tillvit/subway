import net from "net";
import { ConnectionHandler, ConnectionMap, MessageType, Serialize } from "./protocol.js";

const EXPOSE_PORT = 8199
const REMOTE_PORT = 8198

const auth = "53c4b0ea24158fa16066817775d73413"

let remoteSocket = null

const connectionMap = new ConnectionMap()

function buf2hex(buffer) { // buffer is an ArrayBuffer
  return [...new Uint8Array(buffer)]
      .map(x => x.toString(16).padStart(2, '0'))
      .join('');
}

const exposeServer = net.createServer((socket) => {
  if (!remoteSocket) {
    socket.destroy()
    return
  }
  console.log(`Client connected to expose server from ${socket.remoteAddress}:${socket.remotePort}`)
  const mapId = connectionMap.assign(socket)

  remoteSocket.write(Serialize({
    type: MessageType.CREATE_CONNECTION,
    mapId: mapId
  }))

  socket.on("close", () => {
    connectionMap.close(mapId)
    // Type 2 = close connection
    remoteSocket?.write(Serialize({
      type: MessageType.CLOSE_CONNECTION,
      mapId: mapId
    }))
    console.log(`Expose client disconnected for mapId ${mapId}`)
  })

  socket.on("data", (data) => {
    console.log(`Received from client: `, data)
    remoteSocket?.write(Serialize({
      type: MessageType.DATA,
      mapId: mapId,
      payload: data
    }))
  })
  socket.on("error", (err) => {
    console.error("Expose socket error:", err)
    connectionMap.close(mapId)
    remoteSocket?.write(Serialize({
      type: MessageType.CLOSE_CONNECTION,
      mapId: mapId
    }))
  })
})


const remoteServer = net.createServer((socket) => {
  console.log(`Client connected to remote server from ${socket.remoteAddress}:${socket.remotePort}`)

  if (!remoteSocket) {
    remoteSocket = socket
  }
  let authenticated = false
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
        if (receivedToken === auth) {
          authenticated = true
          clearTimeout(authTimeout)
          console.log("Client authenticated successfully.")
        } else {
          console.warn("Client failed to authenticate. Disconnecting.")
          socket.destroy()
        }
        break
      case MessageType.DATA: // DATA
        if (!authenticated) {
          console.warn("Received data before authentication. Ignoring.")
          socket.destroy()
        }
        const clientSocket = connectionMap.get(packet.mapId)
        if (clientSocket) {
          clientSocket.write(packet.payload)
        }
        break
      case MessageType.CLOSE_CONNECTION: // CLOSE_CONNECTION
        if (!authenticated) {
          console.warn("Received data before authentication. Ignoring.")
          socket.destroy()
        }
        connectionMap.close(packet.mapId)
        break
    }
  }

  socket.on("data", (data) => {
    parser.push(data);
  })

  socket.on("close", () => {
    if (socket === remoteSocket) {
      remoteSocket = null
      connectionMap.clear()
      console.warn(`Remote socket disconnected.`)
    }
    clearInterval(parserDebugInterval);
  })
})

exposeServer.listen(EXPOSE_PORT, () => {
  console.log(`Expose server listening on port ${EXPOSE_PORT}`)
})
remoteServer.listen(REMOTE_PORT, () => {
  console.log(`Remote server listening on port ${REMOTE_PORT}`)
})
