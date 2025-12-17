import net from "net"

const server = net.createServer((socket) => {
  console.log(`Client connected from ${socket.remoteAddress}:${socket.remotePort}`)
  socket.on("data", (data) => {
    console.log(`Received from client: ${data}`)
    socket.write(`Echo: ${data}`)
  })
  socket.on("close", () => {
    console.log("Client disconnected")
  })
})

const EXPOSED_PORT = 62626

server.listen(EXPOSED_PORT, () => {
  console.log(`Exposed server listening on port ${EXPOSED_PORT}`)
})

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

while (true) {
  await sleep(300000);
}