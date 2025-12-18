export const MessageType = {
    AUTH: 0,
    CREATE_CONNECTION: 1,
    CLOSE_CONNECTION: 2,
    DATA: 3,
}

const writeULEB128 = (value) => {
    const bytes = []
    do {
        let byte = value & 0x7F
        value >>= 7
        if (value !== 0) {
            byte |= 0x80
        }
        bytes.push(byte)
    } while (value !== 0)
    return Buffer.from(bytes)
}

const readShort = (bytes) => {
    return (bytes[0] << 8) | bytes[1]
}

class Lock {
    acquired = false;
    queue = [];

    async acquire() {
        if (!this.acquired) {
            this.acquired = true;
        } else {
            return new Promise((resolve, _) => {
                this.queue.push(resolve);
            });
        }
    }

    async release() {
        if (this.queue.length === 0 && this.acquired) {
            this.acquired = false;
            return;
        }

        const continuation = this.queue.shift();
        return new Promise((res) => {
            continuation();
            res();
        });
    }
}

export class RingBuffer {
    constructor(size) {
        this.buffer = Buffer.alloc(size)
        this.size = size
        this.start = 0
        this.end = 0
    }

    get length() {
        if (this.end >= this.start) {
            return this.end - this.start
        } else {
            return this.size - this.start + this.end
        }
    }

    push(data) {
        for (let i = 0; i < data.length; i++) {
            this.buffer[this.end] = data[i]
            this.end = (this.end + 1) % this.size
        }
    }

    read(length) {
        if (length > this.length) {
            length = this.length
        }
        const result = Buffer.alloc(length)
        for (let i = 0; i < length; i++) {
            result[i] = this.buffer[(this.start + i) % this.size]
        }
        return result
    }

    readRange(start, end) {
        const result = Buffer.alloc(end - start)
        for (let i = start; i < end; i++) {
            result[i - start] = this.buffer[(this.start + i) % this.size]
        }
        return result
    }

    readULEB128(offset) {
        let result = 0
        let shift = 0
        let byte
        let bytesRead = 0

        do {
            byte = this.buffer[(this.start + offset + bytesRead) % this.size]
            result |= (byte & 0x7F) << shift
            shift += 7
            bytesRead++
        } while (byte & 0x80)

        return {value: result, length: bytesRead}
    }

    removeStart(length) {
        this.start = (this.start + length) % this.size
    }

    clear() {
        this.start = 0
        this.end = 0
    }
}

export class ConnectionHandler {
    constructor(onPacket) {
        this.buffer = new RingBuffer(1048576)
        this.onPacket = onPacket
        this.lock = new Lock()
    }

    reset() {
        this.buffer.clear()
    }

    async push(data) {
        await this.lock.acquire();
        this.buffer.push(data)
        this._parse()
        this.lock.release();
    }

    _parse() {
        while (this.buffer.length > 0) {
            const messageType = this.buffer.read(1)[0]
            switch (messageType) {
                case MessageType.AUTH: {
                    const AUTH_TOKEN_LENGTH = 16
                    if (this.buffer.length < 1 + AUTH_TOKEN_LENGTH) {
                        return
                    }
                    const authToken = this.buffer.readRange(1, 1 + AUTH_TOKEN_LENGTH)
                    this.onPacket?.({type: MessageType.AUTH, authToken})
                    this.buffer.removeStart(1 + AUTH_TOKEN_LENGTH)
                    break
                }
                case MessageType.CREATE_CONNECTION: {
                    if (this.buffer.length < 3) {
                        return
                    }
                    const mapId = readShort(this.buffer.readRange(1, 3))
                    this.onPacket?.({type: MessageType.CREATE_CONNECTION, mapId})
                    this.buffer.removeStart(3)
                    break
                }
                case MessageType.CLOSE_CONNECTION: {
                    if (this.buffer.length < 3) {
                        return
                    }
                    const mapId = readShort(this.buffer.readRange(1, 3))
                    this.onPacket?.({type: MessageType.CLOSE_CONNECTION, mapId})
                    this.buffer.removeStart(3)
                    break
                }
                case MessageType.DATA: {
                    if (this.buffer.length < 3) {
                        return
                    }
                    const mapId = readShort(this.buffer.readRange(1, 3))
                    let {value: length, length: lengthBytes} = this.buffer.readULEB128(3)
                    if (this.buffer.length < 3 + lengthBytes + length) {
                        return
                    }
                    const payload = Buffer.from(this.buffer.readRange(3 + lengthBytes, 3 + lengthBytes + length))
                    this.onPacket?.({type: MessageType.DATA, mapId, payload})
                    this.buffer.removeStart(3 + lengthBytes + length)
                    break
                }
            }
        }
    }
}

export function serialize(message) {
    switch (message.type) {
        case MessageType.AUTH: {
            const authBuffer = Buffer.from(message.authToken)
            return Buffer.concat([Buffer.from([MessageType.AUTH]), authBuffer])
        }
        case MessageType.CREATE_CONNECTION: {
            return Buffer.from([MessageType.CREATE_CONNECTION, (message.mapId >> 8) & 0xFF, message.mapId & 0xFF])
        }
        case MessageType.CLOSE_CONNECTION: {
            return Buffer.from([MessageType.CLOSE_CONNECTION, (message.mapId >> 8) & 0xFF, message.mapId & 0xFF])
        }
        case MessageType.DATA: {
            const header = Buffer.from([MessageType.DATA, (message.mapId >> 8) & 0xFF, message.mapId & 0xFF])
            const length = writeULEB128(message.payload.byteLength)
            return Buffer.concat([header, length, Buffer.from(message.payload)])
        }
    }
}

export class ConnectionMap {
    constructor() {
        this.map = new Map()
    }

    assign(socket, mapId) {
        if (mapId !== undefined && this.map.has(mapId)) {
            throw new Error(`Map ID ${mapId} is already in use`)
        } else if (mapId !== undefined) {
            this.map.set(mapId, socket)
            return mapId
        }
        mapId = Math.floor(Math.random() * 0xFFFF)
        while (this.map.has(mapId)) {
            mapId = Math.floor(Math.random() * 0xFFFF)
        }
        this.map.set(mapId, socket)
        return mapId
    }

    get(mapId) {
        return this.map.get(mapId)
    }

    close(mapId) {
        this.map.get(mapId)?.destroy()
        this.map.delete(mapId)
    }

    clear() {
        for (const socket of this.map.values()) {
            socket.destroy()
        }
        this.map.clear()
    }
}
