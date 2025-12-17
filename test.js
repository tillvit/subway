import net from "net"

const EXPOSED_SERVER = "localhost"
const EXPOSED_PORT = 8199

const socket = new net.Socket()

socket.connect(EXPOSED_PORT, EXPOSED_SERVER, () => {
  console.log(`Connected to exposed server at ${EXPOSED_SERVER}:${EXPOSED_PORT}`)
  socket.write("Hello from client to exposed server!")
})

socket.on("data", (data) => {
  console.log(`Received from exposed server: ${data}`)
  socket.write("Ping!")
})

socket.on("close", () => {
  console.log("Connection to exposed server closed")
})


async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

while (true) {
  await sleep(300000);
}