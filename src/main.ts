import socketio, { Socket } from "socket.io";

import { ExpressPeerServer } from "peer";
import { v4 } from "uuid";

import express from "express";
import http from "http";
import path from "path";
import sslRedirect from "heroku-ssl-redirect";

import { AUProximityState } from "./types/models/AUProximityState";

import Client from "./Client";
import logger from "./util/logger";

const app = express();

app.use(sslRedirect());
app.use(express.static(path.join(__dirname, "dist")));

const server = http.createServer(app);

const io = new socketio.Server(server, process.env.NODE_ENV === "production" ? {} : {
    cors: { origin: "http://localhost:8080" }
});

app.use("/peerjs", ExpressPeerServer({
    // eslint-disable-next-line
    // @ts-ignore
    on(event, peerServerHandler) {
        server.on(event, (req, a, b) => {
            if (event === "upgrade" && !req.url.includes("socket.io")) {
                peerServerHandler(req, a, b);
            }
        });
    }
}));

export const state: AUProximityState = {
    allClients: [],
    allRooms: [],
    isClosed: false
};

io.on("connection", (socket: Socket) => {
    const client = new Client(socket, v4());
    state.allClients.push(client);
    logger.log("User connected, uuid:", client.uuid);
});


app.all("*", (req, res) => {
    res.sendFile(path.join(__dirname, "dist", "index.html"));
});

const port = process.env.PORT || 8079;
server.listen(port, () => {
    logger.success(`Listening on port ${port}`);
});

async function gracefulShutdown() {
    logger.info("Shutting down gracefully..");
    logger.info("Waiting for all rooms (" + state.allRooms.length + ") currently playing to finish. Press Ctrl + C to exit immediately.");
    state.isClosed = true;
    await Promise.allSettled(
        state.allRooms.map(room => room.gracefulDestroy()),
    );
    logger.success("All running games were closed, goodbye.");
    process.exit();
}

process.on("SIGINT", gracefulShutdown);

process.on("message", async msg => {
    logger.log(msg);
    if (msg === "shutdown") {
        await gracefulShutdown();
    }
});