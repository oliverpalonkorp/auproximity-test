module.exports = {
    apps: [{
        name: "auproximity",
        script: "./dist/main.js",
        kill_timeout: 10 * 60 * 1000,
        shutdown_with_message: process.platform === "win32"
    }]
};