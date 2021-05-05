module.exports = {
	apps: [
		{
			name: "auproximity",
			script: "./dist/main.js",
			kill_timeout: 10 * 60 * 1000,
			log_date_format: "YYYY-MM-DD HH:mm Z",
			shutdown_with_message: process.platform === "win32",
			args: ["--color"],
		},
	],
};
