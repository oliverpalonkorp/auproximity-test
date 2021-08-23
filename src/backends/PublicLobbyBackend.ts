import util from "util";
import dns from "dns";
import ch from "chalk";

import * as skeldjs from "@skeldjs/client";
import * as protocol from "@skeldjs/protocol";

import logger from "../util/logger";

import { PublicLobbyBackendModel } from "../types/models/Backends";
import { MatchmakerServers } from "../types/constants/MatchmakerServers";

import { GameSettings } from "../types/models/ClientOptions";
import { PlayerFlag } from "../types/enums/PlayerFlags";
import { GameState } from "../types/enums/GameState";
import { GameFlag } from "../types/enums/GameFlags";

import { BackendAdapter, LogMode } from "./Backend";

const GAME_VERSION = "2021.6.30.0";

const chalk = new ch.Instance({ level: 2 });

function fmtName(
	player: skeldjs.PlayerData | undefined,
	gamedata?: skeldjs.PlayerInfo
) {
	if (!player) return chalk.grey("<No Data>");

	const info = gamedata || player.info;

	const colour = info ? info.color : skeldjs.Color.Gray;
	const name = info ? info.name || "<No Name>" : "<No Data>";
	const id = player.id || "<No ID>";

	const consoleClr: ch.Chalk = skeldjs.ColorCodes[
		colour as keyof typeof skeldjs.ColorCodes
	]?.highlightHex
		? chalk.hex(skeldjs.ColorCodes[colour]?.highlightHex)
		: chalk.gray;

	return consoleClr(name) + " " + chalk.grey("(" + id + ")");
}

const sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const lookupDns = util.promisify(dns.lookup);

export enum ConnectionErrorCode {
	None,
	NoClient,
	FailedToConnect,
	TimedOut,
	GameNotFound,
	FailedToJoin,
	IncorrectChatMode,
}

export type RegionServers = [string, number][];

export default class PublicLobbyBackend extends BackendAdapter {
	static OfficialServers: Record<string, RegionServers> = {};

	backendModel: PublicLobbyBackendModel;

	client: skeldjs.SkeldjsClient | undefined;

	master: RegionServers;
	server: number;

	players_cache: Map<number, skeldjs.PlayerData<skeldjs.SkeldjsClient>>;
	components_cache: Map<
		number,
		skeldjs.Networkable<
			unknown,
			skeldjs.NetworkableEvents,
			skeldjs.SkeldjsClient
		>
	>;
	global_cache: (skeldjs.Networkable<skeldjs.SkeldjsClient> | null)[];

	settings: GameSettings;

	constructor(backendModel: PublicLobbyBackendModel) {
		super();

		this.backendModel = backendModel;
		this.gameID = this.backendModel.gameCode;
		this.settings = {
			map: skeldjs.GameMap.TheSkeld,
			crewmateVision: 1,
		};
	}

	log(mode: LogMode, format: string, ...params: unknown[]): void {
		const formatted = util.format(format, ...params);

		logger[mode](chalk.grey("[" + this.backendModel.gameCode + "]"), formatted);
	}

	getVentName(ventid: number): string | null {
		if (!this.client) return null;

		const map = this.client.settings.map;
		const data = skeldjs.MapVentData[map][ventid];

		if (!data) return null;

		switch (map) {
			case skeldjs.GameMap.TheSkeld:
				return skeldjs.TheSkeldVent[data.id];
			case skeldjs.GameMap.MiraHQ:
				return skeldjs.MiraHQVent[data.id];
			case skeldjs.GameMap.Polus:
				return skeldjs.PolusVent[data.id];
			case skeldjs.GameMap.Airship:
				return skeldjs.AirshipVent[data.id];
		}

		return null;
	}

	async doJoin(max_attempts = 5, attempt = 0): Promise<boolean> {
		if (this.destroyed) return false;

		if (attempt >= max_attempts) {
			this.log(LogMode.Fatal, "Couldn't join game.");
			this.emitError(
				"Couldn't join the game after " +
					max_attempts +
					" attempts, make sure that the game hasn't started and there is a spot for the client.",
				true
			);
			return false;
		}

		if (!this.client) {
			this.client = new skeldjs.SkeldjsClient(GAME_VERSION, {
				allowHost: false,
				chatMode: skeldjs.QuickChatMode.FreeChat,
			});
		}

		if (!this.players_cache || !this.components_cache || !this.global_cache) {
			const err = await this.initialSpawn(attempt >= max_attempts);

			if (err === ConnectionErrorCode.GameNotFound) {
				this.log(LogMode.Fatal, "Couldn't find game.");
				this.emitError(
					"Couldn't find the game, make sure that you entered the code correctly and you are using the correct region.",
					true
				);
				return false;
			}

			if (err === ConnectionErrorCode.FailedToJoin) {
				this.log(LogMode.Fatal, "Couldn't join game.");
				this.emitError(
					"Couldn't join the game, make sure that the game hasn't started and there is a spot for the client.",
					true
				);
				return false;
			}

			if (err !== ConnectionErrorCode.None) {
				if (err !== ConnectionErrorCode.NoClient) {
					await this.client.disconnect();
				}

				this.server++;
				this.server = this.server % this.master.length;
				attempt++;

				const remaining = max_attempts - attempt;
				if (remaining === 0) {
					this.log(
						LogMode.Warn,
						"Failed to initially spawn after",
						max_attempts,
						"attempts."
					);
					this.emitError(
						"Couldn't connect to the server after " +
							max_attempts +
							" attempts.",
						false
					);
				} else {
					if (err === ConnectionErrorCode.IncorrectChatMode) {
						this.log(
							LogMode.Warn,
							"Failed to initially spawn, Retrying %s more time%s, also trying another chat mode, since %s didn't work",
							remaining,
							remaining === 1 ? "" : "s", // plural
							skeldjs.QuickChatMode[this.client.options.chatMode]
						);
						this.client.options.chatMode =
							this.client.options.chatMode === skeldjs.QuickChatMode.FreeChat
								? skeldjs.QuickChatMode.QuickChat
								: skeldjs.QuickChatMode.FreeChat; // invert chat mode
					} else {
						this.log(
							LogMode.Warn,
							"Failed to initially spawn, Retrying %s more time%s, also trying another server",
							remaining,
							remaining === 1 ? "" : "s" // plural
						);
					}
					this.emitError(
						"Couldn't connect to the server. Retrying " +
							remaining +
							" more time" +
							(remaining === 1 ? "" : "s") +
							".",
						false
					);
				}
				return this.doJoin(max_attempts, attempt);
			}
		}

		if (this.destroyed) return false;

		const ip = this.master[this.server][0];
		const port = this.master[this.server][1];

		this.log(
			LogMode.Info,
			"Joining game with server %s:%i, not spawning, attempt #%i",
			ip,
			port,
			attempt + 1
		);

		try {
			await this.client.connect(ip, undefined, port);
			await this.client.identify("Roundcar", this.client.token);
		} catch (e) {
			const err = e as Error;
			this.server++;
			this.server = this.server % this.master.length;
			attempt++;

			this.log(
				LogMode.Warn,
				"Failed to connect (" +
					err.message +
					"), Retrying " +
					(max_attempts - attempt) +
					" more times, also trying another server."
			);
			this.emitError(
				"Couldn't connect to the server. Retrying " +
					(max_attempts - attempt) +
					" more times.",
				false
			);
			return await this.doJoin(max_attempts, attempt);
		}

		this.log(LogMode.Info, "Successfully connected to server.");

		try {
			await this.client.joinGame(this.backendModel.gameCode, false);
		} catch (e) {
			const err = e as Error;
			attempt++;

			if (err.message.includes("Could not find the game you're looking for.")) {
				this.log(LogMode.Fatal, e.toString());
				return false;
			}

			this.log(
				LogMode.Warn,
				"Failed to join game (" +
					err.message +
					"), Retrying " +
					(max_attempts - attempt) +
					" more times."
			);
			this.emitError(
				err.message + ". Retrying " + (max_attempts - attempt) + " more times.",
				false
			);
			return await this.doJoin(max_attempts, attempt);
		}

		this.log(LogMode.Success, "Successfully joined!");
		this.log(
			LogMode.Info,
			"Replacing state with cached state.. (%i objects, %i netobjects, %i room components)",
			this.players_cache.size,
			this.components_cache.size,
			this.global_cache.length
		);

		if (!this.client) {
			await this.destroy();
			return false;
		}

		for (const [id, object] of this.players_cache) {
			if (!object) continue;

			object.room = this.client;
			this.client.objects.set(id, object);
			this.client.players.set(id, object);
		}

		for (const [id, component] of this.components_cache) {
			if (!component) continue;

			component.room = this.client;
			this.client.netobjects.set(id, component);
		}

		for (let i = 0; i < this.global_cache.length; i++) {
			const component = this.global_cache[i];

			if (!component) continue;

			component.room = this.client;
			this.client.components[i] = component;
		}

		this.log(LogMode.Success, "Joined & successfully replaced state!");

		if (this.client.host && this.client.host.info) {
			this.log(LogMode.Success, "Found host: " + fmtName(this.client.host));

			this.emitHostChange(this.client.host.info.name);
		}
		return true;
	}

	resetObjectCaches(): void {
		if (!this.client) return;

		this.players_cache = new Map(
			[...this.client.objects.entries()].filter(
				([objectid]) =>
					objectid !== this.client?.clientid && objectid > 0 /* not global */
			)
		) as Map<number, skeldjs.PlayerData<skeldjs.SkeldjsClient>>;
		this.components_cache = new Map(
			[...this.client.netobjects.entries()].filter(
				([, component]) => component.ownerid !== this.client?.clientid
			)
		);
		this.global_cache = this.client.components;
	}

	async disconnect(): Promise<void> {
		this.resetObjectCaches();
		await this.client?.disconnect();
	}

	async resolveMMDNS(region: string, names: string[]): Promise<RegionServers> {
		const regions = PublicLobbyBackend.OfficialServers;
		const servers: [string, number][] = [];

		for (let i = 0; i < names.length; i++) {
			const name = names[i];

			const ips = await lookupDns(name, { all: true, family: 4 });
			const v4 = ips
				.filter((ip) => ip.family === 4)
				.map((ip) => [ip.address, 22023] as [string, number]);

			servers.push(...v4);
		}

		if (!regions[region]) regions[region] = [];
		regions[region].push(...servers);
		return regions[region];
	}

	async initialize(): Promise<void> {
		this.destroyed = false;

		try {
			this.log(
				LogMode.Info,
				"PublicLobbyBackend initialized in region " + this.backendModel.region
			);

			const dns = MatchmakerServers[this.backendModel.region];
			if (!dns) {
				return this.emitError(
					"Couldn't resolve IP for the among us matchmaking services, invalid region '" +
						this.backendModel.region +
						"'.",
					true
				);
			}

			try {
				this.master = await this.resolveMMDNS(this.backendModel.region, dns);
			} catch (e) {
				this.log(LogMode.Error, e);
				return this.emitError(
					"Couldn't resolve IP for the among us matchmaking services, ask an admin to check the logs for more information.",
					true
				);
			}
			this.server = ~~(Math.random() * this.master.length);

			if (!(await this.doJoin())) return;

			if (!this.client) return;

			this.client.on("client.disconnect", async (ev) => {
				this.log(
					LogMode.Info,
					"Client disconnected: " +
						(ev.reason === undefined
							? "No reason."
							: ev.reason + " (" + ev.message + ")")
				);

				if (this.client?.started) await this.destroy();
			});

			this.client.on("player.move", (ev) => {
				if (ev.player?.info) {
					this.emitPlayerPose(ev.player.info.name, ev.position);
				}
			});

			this.client.on("player.snapto", (ev) => {
				if (ev.player?.info) {
					this.log(
						LogMode.Log,
						"Got SnapTo for",
						fmtName(ev.player),
						"to x: " + ev.newPosition.x + " y: " + ev.newPosition.y
					);
					this.emitPlayerPose(ev.player.info.name, ev.newPosition);
				} else {
					this.log(LogMode.Warn, "Got snapto, but there was no data.");
				}
			});

			this.client.on("player.setstartcounter", (ev) => {
				if (ev.newCounter === 5) {
					this.log(LogMode.Info, "Game is starting in 5 seconds");
				}
			});

			this.client.on("room.gamestart", async () => {
				this.emitGameState(GameState.Game);
				this.log(LogMode.Info, "Game started.");
			});

			this.client.on("room.gameend", async () => {
				this.emitGameState(GameState.Lobby);
				this.log(LogMode.Info, "Game ended, clearing cache & re-joining..");

				await this.disconnect();
				await sleep(500);

				await this.doJoin();
			});

			this.client.on("player.sethost", async (ev) => {
				if (!ev.player || !this.client) return;

				if (ev.player.id === this.client.clientid) {
					if (this.client.players.size === 1) {
						this.log(
							LogMode.Info,
							"Everyone left, disconnecting to remove the game."
						);
						await this.client.disconnect();
						await this.destroy();
						return;
					}

					this.log(
						LogMode.Info,
						"I became host, disconnecting and re-joining.."
					);

					await this.disconnect();

					if (!(await this.doJoin())) this.destroy();
					return;
				}

				if (ev.player && ev.player.info) {
					this.log(LogMode.Info, fmtName(ev.player), " is now the host.");
					this.emitHostChange(ev.player.info.name);
				} else {
					this.log(LogMode.Warn, "Host changed, but there was no data.");
				}
			});

			this.client.on("player.join", (ev) => {
				if (!ev.player) return;

				this.log(
					LogMode.Info,
					"Player with ID " + ev.player.id + " joined the game."
				);
			});

			this.client.on("player.leave", (ev) => {
				if (!ev.player) return;

				this.log(
					LogMode.Log,
					"Player with ID " + ev.player.id + " left or was removed."
				);
			});

			this.client.on("system.sabotage", (ev) => {
				if (ev.system.systemType === skeldjs.SystemType.Communications) {
					this.emitGameFlags(GameFlag.CommsSabotaged, true);
					this.log(LogMode.Info, "Someone sabotaged communications.");
				}
			});

			this.client.on("system.repair", (ev) => {
				if (ev.system.systemType === skeldjs.SystemType.Communications) {
					this.emitGameFlags(GameFlag.CommsSabotaged, false);
					this.log(LogMode.Info, "Someone repaired communications.");
				}
			});

			this.client.on("player.syncsettings", (ev) => {
				if (ev.settings.crewmateVision !== this.settings.crewmateVision) {
					this.settings.crewmateVision = ev.settings.crewmateVision;

					this.log(
						LogMode.Info,
						"Crewmate vision is now set to " + ev.settings.crewmateVision + "."
					);
				}

				if (ev.settings.map !== this.settings.map) {
					this.settings.map = ev.settings.map;

					this.log(
						LogMode.Info,
						"Map is now set to " + skeldjs.GameMap[ev.settings.map] + "."
					);
				}

				this.emitSettingsUpdate(this.settings);
			});

			this.client.on("player.setname", (ev) => {
				if (ev.player?.info) {
					this.log(LogMode.Info, fmtName(ev.player), "updated their name.");
				} else {
					if (ev.player) {
						this.log(
							LogMode.Warn,
							"Name was set for " + ev.player.id + ", but there was no data."
						);
					} else {
						this.log(
							LogMode.Warn,
							"Name was set for a player, but there was no data."
						);
					}
				}
			});

			this.client.on("player.setcolor", (ev) => {
				if (ev.player?.info) {
					this.log(
						LogMode.Info,
						fmtName(ev.player),
						"set their colour to " + skeldjs.Color[ev.newColor] + "."
					);
					this.emitPlayerColor(ev.player.info.name, ev.newColor);
				} else {
					if (ev.player) {
						this.log(
							LogMode.Warn,
							"Color was set for " + ev.player.id + ", but there was no data."
						);
					} else {
						this.log(
							LogMode.Warn,
							"Color was set for a player, but there was no data."
						);
					}
				}
			});

			this.client.on("player.startmeeting", async () => {
				if (!this.client) return;

				const ev = await this.client.wait("component.spawn");
				if (ev.component.classname === "MeetingHud") {
					this.emitGameState(GameState.Meeting);
					const meetinghud = (ev.component as unknown) as skeldjs.MeetingHud;

					const all_states = [...meetinghud.states.values()];
					const state = all_states.find((state) => state.didReport);

					if (state) {
						const player = this.client.getPlayerByPlayerId(state.playerId);

						this.log(LogMode.Log, fmtName(player), "called a meeting.");
					} else {
						this.log(
							LogMode.Warn,
							"Someone called a meeting, but there was no data for the reporter."
						);
					}
				}
			});

			this.client.on("meeting.votingcomplete", async (ev) => {
				this.log(LogMode.Info, "Meeting ended.");
				if (ev.ejected) {
					if (ev.ejected.info) {
						this.emitPlayerFlags(ev.ejected.info.name, PlayerFlag.IsDead, true);
						this.log(LogMode.Log, fmtName(ev.ejected), "was voted off");
					} else {
						this.log(
							LogMode.Warn,
							"Someone was voted off, but there was no data for them."
						);
					}
				} else {
					this.log(LogMode.Info, "No one was voted off.");
				}
				await sleep(7000);
				this.emitGameState(GameState.Game);
			});

			this.client.on("player.murder", (ev) => {
				if (ev.victim && ev.victim.info) {
					this.log(
						LogMode.Info,
						fmtName(ev.player),
						"murdered",
						fmtName(ev.victim) + "."
					);
					this.emitPlayerFlags(ev.victim.info.name, PlayerFlag.IsDead, true);
				} else {
					this.log(
						LogMode.Warn,
						"Someone got murdered, but there was no data."
					);
				}
			});

			this.client.on("player.entervent", (ev) => {
				if (ev.player && ev.player.info) {
					this.log(
						LogMode.Log,
						fmtName(ev.player),
						"entered vent " + this.getVentName(ev.ventid) + "."
					);
					this.emitPlayerVent(ev.player.info.name, ev.ventid);
				} else {
					this.log(
						LogMode.Warn,
						"Someone entered a vent, but there was no data."
					);
				}
			});

			this.client.on("player.exitvent", (ev) => {
				if (ev.player && ev.player.info) {
					this.log(
						LogMode.Log,
						fmtName(ev.player),
						"exited vent " + this.getVentName(ev.ventid) + "."
					);
					this.emitPlayerVent(ev.player.info.name, -1);
				} else {
					this.log(
						LogMode.Warn,
						"Someone exited a vent, but there was no data."
					);
				}
			});

			this.client.on("player.setimpostors", (ev) => {
				for (let i = 0; i < ev.impostors.length; i++) {
					const player = ev.impostors[i];
					if (player?.info) {
						this.log(LogMode.Info, fmtName(player), "was made impostor.");
						this.emitPlayerFlags(player.info.name, PlayerFlag.IsImpostor, true);
					} else {
						this.log(
							LogMode.Warn,
							"Someone was made impostor, but there was no data."
						);
					}
				}
			});

			this.client.on("gamedata.removeplayer", (ev) => {
				if (!this.client) return;

				const player = this.client.getPlayerByPlayerId(ev.player.playerId);

				if (ev.player) {
					this.log(LogMode.Info, "Removed", fmtName(player, ev.player));
					this.emitPlayerColor(ev.player.name, -1);
				}
			});

			this.client.on("security.cameras.join", (ev) => {
				if (ev.player?.info) {
					this.log(LogMode.Info, fmtName(ev.player), "went onto cameras.");
					this.emitPlayerFlags(ev.player.info.name, PlayerFlag.OnCams, true);
				} else {
					this.log(
						LogMode.Warn,
						"Someone went onto cameras, but there was no data."
					);
				}
			});

			this.client.on("security.cameras.leave", (ev) => {
				if (ev.player?.info) {
					this.log(LogMode.Info, fmtName(ev.player), "went off cameras.");
					this.emitPlayerFlags(ev.player.info.name, PlayerFlag.OnCams, false);
				} else {
					this.log(
						LogMode.Warn,
						"Someone went off cameras, but there was no data."
					);
				}
			});

			this.client.on("component.spawn", () => {
				if (process.env.NODE_ENV === "production") return;

				this.log(LogMode.Log, "Component was spawned, resetting object cache.");
				this.resetObjectCaches();
			});

			this.client.on("component.despawn", () => {
				if (process.env.NODE_ENV === "production") return;

				this.log(
					LogMode.Log,
					"Component was despawned, resetting object cache."
				);
				this.resetObjectCaches();
			});

			this.client.on("player.move", (ev) => {
				if (process.env.NODE_ENV === "production") return;

				if (ev.player?.info) {
					this.log(
						LogMode.Log,
						fmtName(ev.player),
						"moved to X: " + ev.position.x + ", Y: " + ev.position.y
					);
				} else {
					this.log(LogMode.Log, "A player moved but there was no data.");
				}
			});

			this.log(LogMode.Success, "Initialized PublicLobbyBackend!");
		} catch (err) {
			this.log(LogMode.Error, "An error occurred.");
			this.log(LogMode.Error, err);
			this.emitError(
				"An unknown error occurred, join the discord to contact an admin for help.",
				true
			);
			await this.destroy();
		}
	}

	awaitSpawns(): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			if (!this.client) return resolve(false);

			const playersSpawned: number[] = [];
			let gamedataSpawned = false;

			// eslint-disable-next-line @typescript-eslint/no-this-alias
			const _this = this;

			this.client.on("component.spawn", function onSpawn(ev) {
				if (!_this.client) return;

				if (ev.component.classname === "GameData") {
					gamedataSpawned = true;
					const gamedata = (ev.component as unknown) as skeldjs.GameData;

					for (const [, player] of gamedata.players) {
						if (player.name) _this.emitPlayerColor(player.name, player.color);
					}
				} else if (ev.component.classname === "PlayerControl") {
					playersSpawned.push(ev.component.ownerid);
				}

				if (gamedataSpawned) {
					for (const [clientid] of _this.client.players) {
						if (!playersSpawned.includes(clientid)) {
							return;
						}
					}

					_this.client.off("component.spawn", onSpawn);
					resolve(true);
				}
			});
		});
	}

	async awaitSettings(): Promise<protocol.GameOptions | null> {
		if (!this.client) return null;

		const ev = await this.client.wait("player.syncsettings");
		return ev.settings;
	}

	async initialSpawn(isFinal = false): Promise<ConnectionErrorCode> {
		const ip = this.master[this.server][0];
		const port = this.master[this.server][1];

		if (!this.client) return ConnectionErrorCode.NoClient;

		this.log(
			LogMode.Info,
			"Joining for the first time with server %s:%i",
			ip,
			port
		);
		try {
			await this.client.connect(ip, undefined, port);
			if (!this.client) return ConnectionErrorCode.NoClient;
			await Promise.race([
				this.client.identify("auproxy", this.client.token),
				sleep(2000),
			]);
			if (!this.client.identified) {
				if (isFinal)
					this.emitError(
						"Couldn't connect to the Among Us servers, the servers may be full. Try a different region or try again later.",
						true
					);
				return ConnectionErrorCode.TimedOut;
			}
		} catch (e) {
			this.log(LogMode.Fatal, e.toString());
			this.emitError(
				"Couldn't connect to the Among Us servers, the servers may be full. Try a different region or try again later.",
				true
			);
			return ConnectionErrorCode.FailedToConnect;
		}
		this.log(LogMode.Success, "Successfully connected.");

		if (!this.client) {
			return ConnectionErrorCode.NoClient;
		}

		this.log(LogMode.Info, "Joining room..");
		try {
			const code = await Promise.race([
				this.client.joinGame(this.backendModel.gameCode, false),
				this.client.decoder.wait(protocol.DisconnectPacket),
				sleep(5000),
			]);
			if (typeof code === "object") {
				if (code.message.message?.includes("Incorrect chat mode")) {
					return ConnectionErrorCode.IncorrectChatMode;
				}

				return ConnectionErrorCode.FailedToConnect;
			}
			if (!code) {
				if (isFinal)
					this.emitError("Timed out while connecting to servers.", true);
				return ConnectionErrorCode.TimedOut;
			}
		} catch (e) {
			this.log(LogMode.Fatal, e.toString());

			if (e.toString().includes("Could not find the game")) {
				return ConnectionErrorCode.GameNotFound;
			}

			if (e.toString().includes("Incorrect chat mode")) {
				return ConnectionErrorCode.IncorrectChatMode;
			}

			return ConnectionErrorCode.FailedToJoin;
		}

		this.log(LogMode.Success, "Successfully joined room.");
		this.log(LogMode.Info, "Waiting for spawns and settings..");
		const code = this.client.code;
		if (!code) {
			return ConnectionErrorCode.FailedToJoin;
		}

		this.client.spawnSelf();

		const result = await Promise.race([
			Promise.all([this.awaitSpawns(), this.awaitSettings()]),
			sleep(5000),
		]);
		if (!result) {
			this.log(
				LogMode.Fatal,
				"I didn't receive either spawns or settings from the host."
			);
			if (isFinal)
				this.emitError(
					"Did not recieve players and settings, please restart your Among Us lobby, or wait a few minutes and try again.",
					true
				);
			return ConnectionErrorCode.TimedOut;
		}

		if (!this.client) {
			return ConnectionErrorCode.NoClient;
		}

		const [, settings] = result;

		if (!settings) {
			this.log(LogMode.Fatal, "I didn't receive settings from the host.");
			if (isFinal)
				this.emitError(
					"Did not recieve game settings, please restart your Among Us lobby, or wait a few minutes and try again.",
					true
				);
			return ConnectionErrorCode.TimedOut;
		}

		this.settings.map = settings.map;
		this.settings.crewmateVision = settings.crewmateVision;
		this.emitSettingsUpdate({
			crewmateVision: this.settings.crewmateVision,
			map: settings.map,
		});
		this.log(LogMode.Info, "Crewmate vision is at " + settings.crewmateVision);
		this.log(LogMode.Info, "Map is on " + skeldjs.GameMap[settings.map]);

		if (this.client.host && this.client.host.info) {
			this.emitHostChange(this.client.host.info.name);
		}

		this.log(LogMode.Success, "Got spawns and settings.");
		this.log(LogMode.Info, "Cleaning up and preparing for re-join..");

		for (const [, player] of this.client.players) {
			if (player && player.info) {
				this.emitPlayerColor(player.info.name, player.info.color);
			}
		}

		await this.client.me?.control?.checkName("auproxy");
		await this.client.me?.control?.checkColor(skeldjs.Color.Blue);
		await this.client.me?.wait("player.setname");
		await this.client.me?.control?.sendChat("AUProximity is ready.");

		await sleep(100);

		await this.disconnect();
		return ConnectionErrorCode.None;
	}

	async destroy(): Promise<void> {
		if (this.destroyed) return;

		if (this.client && this.client.socket) {
			this.client.removeListeners("client.disconnect");
			await this.client.disconnect();
			await this.client.destroy();
			this.client = undefined;
		}

		this.log(LogMode.Info, "Destroyed PublicLobbyBackend.");
		this.destroyed = true;
	}
}
