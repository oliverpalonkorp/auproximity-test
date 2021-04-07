import util from "util";
import dns from "dns";
import chalk from "chalk";
import path from "path";
import child_process from "child_process";

import { SkeldjsClient } from "@skeldjs/client";
import * as text from "@skeldjs/text";

const tb = text.tb;

import {
    MapID,
    SystemType,
    ColorID,
    TheSkeldVent,
    MiraHQVent,
    PolusVent,
    AirshipVent
} from "@skeldjs/constant";

import {
    GameOptions
} from "@skeldjs/protocol";

import {
    Networkable,
    PlayerData,
    GameData,
    MapVentData,
    MeetingHud
} from "@skeldjs/core";

import logger from "../util/logger";

import { PublicLobbyBackendModel } from "../types/models/Backends";

import {
    BackendAdapter,
    LogMode
} from "./Backend";

import { PlayerFlag } from "../types/enums/PlayerFlags";
import { GameSettings } from "../types/models/ClientOptions";
import { MatchmakerServers } from "../types/constants/MatchmakerServers";
import { GameState } from "../types/enums/GameState";
import { GameFlag } from "../types/enums/GameFlags";

const GAME_VERSION = "2021.3.25.0";

// Using integer for now, version parsing isn't working on SkeldJS with 2020.3.5.0 for some reason.
// I'm keeping this comment here because it shows how stupid I am that it is in fact 2021 and not 2020.

/*
const colours = {
    red: chalk.redBright,
    blue: chalk.blue,
    green: chalk.green,
    pink: chalk.magentaBright,
    orange: chalk.yellow,
    yellow: chalk.yellowBright,
    grey: chalk.grey,
    white: chalk.white,
    purple: chalk.magenta,
    brown: chalk.red,
    cyan: chalk.cyan,
    lime: chalk.greenBright
};


const fmtName = (player: PlayerData) => {
    if (!player)
        return chalk.grey("No Data");

    const has_data = !!player.data;
    const colour = has_data ? player.data.color : "grey";
    const name = has_data ? player.data.name || "No Name" : "No Data";
    const id = player.id || "No ID";

    const consoleClr: chalk.Chalk = colours[colour] || colours.grey;

    return consoleClr(name) + " (" + chalk.grey(player.id) + ")";
};
*/

const sleep = ms => new Promise<void>(resolve => setTimeout(resolve, ms));
const lookupDns = util.promisify(dns.lookup);

export enum ConnectionErrorCode {
    None,
    NoClient,
    FailedToConnect,
    TimedOut,
    FailedToJoin
}

export type RegionServers = [ string, number ][];

export default class PublicLobbyBackend extends BackendAdapter {
    static OfficialServers: Record<string, RegionServers> = {};

    backendModel: PublicLobbyBackendModel;

    client: SkeldjsClient;

    authToken: number;
    master: RegionServers;
    server: number;

    players_cache: Map<number, PlayerData>;
    components_cache: Map<number, Networkable>;
    global_cache: Networkable[];

    didDisconnect: boolean;

    settings: GameSettings;

    constructor(backendModel: PublicLobbyBackendModel) {
        super();
        
        this.backendModel = backendModel;
        this.gameID = this.backendModel.gameCode;
        this.didDisconnect = false;
        this.settings = {
            map: MapID.TheSkeld,
            crewmateVision: 1
        };
    }

    log(mode: LogMode, format: string, ...params: unknown[]): void {
        const formatted = util.format(format, ...params);

        logger[mode](chalk.grey("[" + this.backendModel.gameCode + "]"), formatted);
    }

    getVentName(ventid: number): string|null {
        const map = this.client.settings.map;
        const data = MapVentData[map][ventid];

        if (!data)
            return null;

        switch (map) {
            case MapID.TheSkeld:
                return TheSkeldVent[data.id];
            case MapID.MiraHQ:
                return MiraHQVent[data.id];
            case MapID.Polus:
                return PolusVent[data.id];
            case MapID.Airship:
                return AirshipVent[data.id];
        }

        return null;
    }

    async doJoin(max_attempts = 5, attempt = 0): Promise<boolean> {
        if (this.destroyed)
            return false;

        if (attempt >= max_attempts) {
            this.log(LogMode.Fatal, "Couldn't join game.");
            this.emitError("Couldn't join the game, make sure that the game hasn't started and there is a spot for the client.", true);
            return false;
        }
        
        if (!this.client) {
            this.client = new SkeldjsClient(GAME_VERSION, { allowHost: false });
        }

        if (!this.players_cache || !this.components_cache || !this.global_cache) {
            const err = await this.initialSpawn(attempt >= max_attempts);
            if (err !== ConnectionErrorCode.None) {
                if (err !== ConnectionErrorCode.NoClient) {
                    if (err === ConnectionErrorCode.FailedToJoin) {
                        this.log(LogMode.Fatal, "Couldn't join game.");
                        this.emitError("Couldn't join the game, make sure that the game hasn't started and there is a spot for the client.", true);
                        return false;
                    }

                    await this.client.disconnect();
                }
                

                this.server++;
                this.server = this.server % this.master.length;
                attempt++;

                const remaining = max_attempts - attempt;
                this.log(LogMode.Warn, "Failed to initially spawn, Retrying " + remaining + " more time" + (remaining === 1 ? "" : "s") + ", also trying another server.");
                this.emitError("Couldn't connect to the server. Retrying " + remaining + " more time" + (remaining === 1 ? "" : "s") + ".", false);
                return this.doJoin(max_attempts, attempt);
            }
        }
        
        if (this.destroyed)
            return false;

        const ip = this.master[this.server][0];
        const port = this.master[this.server][1];

        this.log(LogMode.Info, "Joining game with server %s:%i, not spawning, attempt #%i", ip, port, attempt + 1);
        
        try {
            await this.client.connect(ip, undefined, undefined, port);
            await this.client.identify("auproxy", this.authToken);
        } catch (e) {
            const err = e as Error;
            this.server++;
            this.server = this.server % this.master.length;
            attempt++;

            this.log(LogMode.Warn, "Failed to connect (" + err.message + "), Retrying " + (max_attempts - attempt) + " more times, also trying another server.");
            this.emitError("Couldn't connect to the server. Retrying " + (max_attempts - attempt) + " more times.", false);
            return await this.doJoin(max_attempts, attempt);
        }

        try {
            await this.client.joinGame(this.backendModel.gameCode, false);
        } catch (e) {
            const err = e as Error;
            attempt++;

            this.log(LogMode.Warn, "Failed to join game (" + err.message + "), Retrying " + (max_attempts - attempt) + " more times.");
            this.emitError(err.message + ". Retrying " + (max_attempts - attempt) + " more times.", false);
            return await this.doJoin(max_attempts, attempt);
        }
        
        this.log(LogMode.Info, "Replacing state with cached state.. (%i objects, %i netobjects, %i room components)", this.players_cache.size, this.components_cache.size, this.global_cache.length);

        for (const [ id, object ] of this.players_cache) {
            if (!object)
                continue;

            object.room = this.client;
            this.client.objects.set(id, object);
        }
        
        for (const  [ id, component ] of this.components_cache) {
            if (!component)
                continue;

            component.room = this.client;
            this.client.netobjects.set(id, component);
        }

        for (let i = 0; i < this.global_cache.length; i++) {
            const component = this.global_cache[i];

            if (!component)
                continue;

            component.room = this.client;
            this.client.components[i] = component;
        }

        this.log(LogMode.Success, "Joined & successfully replaced state!");

        if (this.client.host && this.client.host.data) {
            this.log(LogMode.Success, "Found host: " + this.client.host.data.name);

            this.emitHostChange(this.client.host.data.name);
        }
        return true;
    }

    async disconnect(): Promise<void> {
        this.players_cache = new Map([...this.client.objects.entries()].filter(([ objectid ]) => objectid !== this.client.clientid && objectid > 0 /* not global */)) as Map<number, PlayerData>;
        this.components_cache = new Map([...this.client.netobjects.entries()].filter(([ , component ]) => component.ownerid !== this.client.clientid));
        this.global_cache = this.client.components;

        await this.client.disconnect();
        this.didDisconnect = true;
    }

    async resolveMMDNS(region: string, names: string[]): Promise<RegionServers> {
        const regions = PublicLobbyBackend.OfficialServers;
        const servers: [string, number][] = [];

        for (let i = 0; i < names.length; i++) {
            const name = names[i];

            const ips = await lookupDns(name, { all: true, family: 4 });
            const v4 = ips.filter(ip => ip.family === 4).map(ip => [ ip.address, 22023 ] as [string, number]);

            servers.push(...v4);
        }

        if (!regions[region]) regions[region] = [];
        regions[region].push(...servers);
        return regions[region];
    }

    getAuthToken(): Promise<number> {
        return new Promise((resolve, reject) => {
            const ver = process.platform === "win32" ? "win-x64" : "linux-x64";
            const tokenRegExp = /TOKEN:(\d+):TOKEN/;
            
            const pathToGetAuthToken = path.resolve(process.cwd(), "./GetAuthToken/hazeltest/GetAuthToken/bin/Release/net50/" + ver + "/GetAuthToken");
            
            const args = [
                path.resolve(process.cwd(), "./PubsCert.pem"),
                this.master[this.server][0]
            ];
            
            const proc = child_process.spawn(pathToGetAuthToken, args);

            proc.stdout.on("data", chunk => {
                const out = chunk.toString("utf8");

                if (tokenRegExp.test(out)) {
                    const foundToken = tokenRegExp.exec(out.toString("utf8"))[1];
            
                    const authToken = parseInt(foundToken);
                    proc.kill();
                    resolve(authToken);
                }
            });
        
            proc.on("error", err => {
                proc.kill();
                reject(err);
            });

            // eslint-disable-next-line promise/catch-or-return, promise/always-return
            sleep(5000).then(() => {
                proc.kill();
                reject(new Error("GetAuthToken took too long to get a token."));
            });
        });
    }

    async tryGetAuthToken(cur_attempt = 0): Promise<number> {
        try {
            return await this.getAuthToken();
        } catch (e) {
            cur_attempt++;
            const remaining = 5 - cur_attempt;
            
            this.log(LogMode.Error, "Failed to get authorisation token, trying " + remaining + " more times. " + (e?.message?.toString() || e));

            if (remaining) {
                this.emitError("Failed to authorize with among us servers, trying " + remaining + " more times.", false);
                return await this.tryGetAuthToken(cur_attempt);
            } else {
                await this.destroy();
                return null;
            }
        }
    }

    async initialize(): Promise<void> {
        this.destroyed = false;

        try {
            this.log(LogMode.Info, "PublicLobbyBackend initialized in region " + this.backendModel.region);

            const dns = MatchmakerServers[this.backendModel.region];

            if (!dns) {
                return this.emitError("Couldn't resolve IP for the among us matchmaking services, invalid region '" + this.backendModel.region + "'.", true);
            }

            try {
                this.master = await this.resolveMMDNS(this.backendModel.region, dns);
            } catch (e) {
                this.log(LogMode.Error, e);
                return this.emitError("Couldn't resolve IP for the among us matchmaking services, ask an admin to check the logs for more information.", true);
            }
            this.server = ~~(Math.random() * this.master.length);

            // TODO: Implement actual getting-auth-token (probably in skeldjs).
            // Currently the GetAuthToken program is closed source to avoid cheating.
            // This means that the PublicLobbyBackend will not work for those looking to self-host.
            // You can still however use the Impostor backend, although it requires setting up an impostor private server.
            // See https://github.com/auproximity/Impostor for the fork of Impostor required.
            // See https://github.com/auproximity/AUP-Impostor for the plugin.

            this.log(LogMode.Info, "Getting authorisation token from server..");
            this.authToken = await this.tryGetAuthToken();

            if (!this.authToken) {
                this.log(LogMode.Fatal, "Failed to get auth token.");
                return this.emitError("Could not get authorization token, ask an admin to check the logs for more information.", true);
            }

            this.log(LogMode.Success, "Successfully got authorization token from the server.");

            if (!await this.doJoin())
                return;

            this.client.on("client.disconnect", async ev => {
                const { reason, message } = ev.data;

                this.log(LogMode.Info, "Client disconnected: " + (reason === undefined ? "No reason." : (reason + " (" + message + ")")));
            });

            this.client.on("player.move", ev => {
                const { player, position } = ev.data;

                if (player.data) {
                    this.emitPlayerPosition(player.data.name, position);
                }
            });

            this.client.on("player.snapto", ev => {
                const { player, position } = ev.data;

                if (player.data) {
                    this.log(LogMode.Log, "Got SnapTo for " + player.data.name + " (" + player.id + ") to x: " + position.x + " y: " + position.y);
                    this.emitPlayerPosition(player.data.name, position);
                } else {
                    this.log(LogMode.Warn, "Got snapto, but there was no data.");
                }
            });

            this.client.on("player.setstartcounter", ev => {
                const { counter } = ev.data;

                if (counter <= 5 && counter > 0) {
                    this.log(LogMode.Info, "Game is starting in " + counter + " second" + (counter === 1 ? "" : "s"));
                }
            });

            this.client.on("game.start", async () => {
                this.emitGameState(GameState.Game);
                this.log(LogMode.Info, "Game started.");
            });

            this.client.on("game.end", async () => {
                this.emitGameState(GameState.Lobby);
                this.log(LogMode.Info, "Game ended, re-joining..");
                
                if (!await this.doJoin())
                    return;
            });

            this.client.on("player.sethost", async ev => {
                const { player: host } = ev.data;

                if(!host)
                    return;

                if (host.id === this.client.clientid) {
                    if (this.client.players.size === 1) {
                        this.log(LogMode.Warn, "Everyone left, disconnecting to remove the game.");
                        await this.client.disconnect();
                        await this.destroy();
                        return;
                    }

                    this.log(LogMode.Warn, "I became host, disconnecting and re-joining..");
                    
                    await this.disconnect();

                    if (!await this.doJoin())
                        this.destroy();
                    return;
                }

                if (host && host.data) {
                    this.log(LogMode.Info, host.data.name + " is now the host.");
                    this.emitHostChange(host.data.name);
                } else {
                    this.log(LogMode.Warn, "Host changed, but there was no data.");
                }
            });

            this.client.on("player.join", ev => {
                const { player } = ev.data;
                this.log(LogMode.Info, "Player with ID " + player.id + " joined the game.");
            });

            this.client.on("player.leave", ev => {
                const { player } = ev.data;
                this.log(LogMode.Log, "Player with ID " + player.id + " left or was removed.");
            });

            this.client.on("system.sabotage", ev => {
                const { system } = ev.data;
                if (system.systemType === SystemType.Communications) {
                    this.emitGameFlags(GameFlag.CommsSabotaged, true);
                    this.log(LogMode.Info, "Someone sabotaged communications.");
                }
            });

            this.client.on("system.repair", ev => {
                const { system } = ev.data;
                if (system.systemType === SystemType.Communications) {
                    this.emitGameFlags(GameFlag.CommsSabotaged, false);
                    this.log(LogMode.Info, "Someone repaired communications.");
                }
            });

            this.client.on("player.syncsettings", ev => {
                const { settings } = ev.data;
                if (settings.crewmateVision !== this.settings.crewmateVision) {
                    this.settings.crewmateVision = settings.crewmateVision;

                    this.log(LogMode.Info, "Crewmate vision is now set to " + settings.crewmateVision + ".");
                }
                
                if (settings.map !== this.settings.map) {
                    this.settings.map = settings.map;

                    this.log(LogMode.Info, "Map is now set to " + MapID[settings.map] + ".");
                }
                
                this.emitSettingsUpdate(this.settings);
            });

            this.client.on("player.setname", ev => {
                const { player, name } = ev.data;
                if (player.data) {
                    this.log(LogMode.Info, player.id + " set their name to " + name + ".");
                } else {
                    if (player) {
                        this.log(LogMode.Warn, "Name was set for " + player.id + ", but there was no data.");
                    } else {
                        this.log(LogMode.Warn, "Name was set for a player, but there was no data.");
                    }
                }
            });

            this.client.on("player.setcolor", ev => {
                const { player, color } = ev.data;
                if (player?.data) {
                    this.log(LogMode.Info, player.data.name + " set their colour to " + ColorID[color] + ".");
                    this.emitPlayerColor(player.data.name, color);
                } else {
                    if (player) {
                        this.log(LogMode.Warn, "Color was set for " + player.id + ", but there was no data.");
                    } else {
                        this.log(LogMode.Warn, "Color was set for a player, but there was no data.");
                    }
                }
            });

            this.client.on("player.meeting", async () => {
                const ev = await this.client.wait("component.spawn");
                const { component } = ev.data;
                if (component.classname === "MeetingHud") {
                    const meetinghud = component as MeetingHud;
                    this.emitGameState(GameState.Meeting);

                    const all_states = [...meetinghud.states.values()];
                    const state = all_states.find(state => state.reported);
                    
                    if (state) {
                        const player = this.client.getPlayerByPlayerId(state.playerId);
                        
                        if (player) {
                            if (player.data) {
                                this.log(LogMode.Log, player.data.name + " (" + player.id + ") called a meeting.");
                            } else {
                                this.log(LogMode.Warn, "A player with ID " + player.id + " called a meeting, but there was no data.");
                            }
                        } else {
                            this.log(LogMode.Warn, "Someone called a meeting, but there was no data for the reporter.");
                        }
                    } else {
                        this.log(LogMode.Warn, "Someone called a meeting, but there was no data for the reporter.");
                    }
                }
            });

            this.client.on("meetinghud.votingcomplete", ev => {
                const { ejected } = ev.data;
                if (ejected && ejected.data) {
                    this.emitGameState(GameState.Game);
                    this.emitPlayerFlags(ejected.data.name, PlayerFlag.IsDead, true);
                    this.log(LogMode.Log, ejected.data.name + " (" + ejected.id + ") was voted off");
                }
            });

            this.client.on("player.murder", ev => {
                const { victim } = ev.data;
                if (victim && victim.data) {
                    this.log(LogMode.Info, victim.data.name + " (" + victim.id + ") was murdered.");
                    this.emitPlayerFlags(victim.data.name, PlayerFlag.IsDead, true);
                } else {
                    this.log(LogMode.Warn, "Someone got murdered, but there was no data.");
                }
            });

            this.client.on("player.entervent", ev => {
                const { player, ventid } = ev.data;
                if (player && player.data) {
                    this.log(LogMode.Log, player.data.name + " (" + player.id + ") entered vent '" + this.getVentName(ventid) + "'.");
                    this.emitPlayerFlags(player.data.name, PlayerFlag.InVent, true);
                } else {
                    this.log(LogMode.Warn, "Someone entered a vent, but there was no data.");
                }
            });

            this.client.on("player.exitvent", ev => {
                const { player, ventid } = ev.data;
                if (player && player.data) {
                    this.log(LogMode.Log, player.data.name + " (" + player.id + ") exited vent '" + this.getVentName(ventid) + "'.");
                    this.emitPlayerFlags(player.data.name, PlayerFlag.InVent, true);
                } else {
                    this.log(LogMode.Warn, "Someone exited a vent, but there was no data.");
                }
            });

            this.client.on("player.setimpostors", ev => {
                const { impostors } = ev.data;
                for (let i = 0; i < impostors.length; i++) {
                    const player = impostors[i];
                    if (player?.data) {
                        this.log(LogMode.Info, player.data.name + " was made impostor.");
                        this.emitPlayerFlags(player.data.name, PlayerFlag.IsImpostor, true);
                    } else {
                        this.log(LogMode.Warn, "Someone was made impostor, but there was no data.");
                    }
                }
            });

            this.client.on("gamedata.removeplayer", ev => {
                const { playerData } = ev.data;
                const client = this.client.getPlayerByPlayerId(playerData.playerId);

                if (playerData) {
                    this.log(LogMode.Info, "Removed " + playerData.name + (client ? " (" + client.id + ")" : ""));
                    this.emitPlayerColor(playerData.name, -1);
                }
            });

            this.client.on("security.cameras.join", ev => {
                const { player } = ev.data;
                if (player?.data) {
                    this.log(LogMode.Info, player.data.name + " (" + player.id + ") went onto cameras.");
                    this.emitPlayerFlags(player.data.name, PlayerFlag.OnCams, true);
                } else {
                    this.log(LogMode.Warn, "Someone went onto cameras, but there was no data.");
                }
            });

            this.client.on("security.cameras.leave", ev => {
                const { player } = ev.data;
                if (player?.data) {
                    this.log(LogMode.Info, player.data.name + " (" + player.id + ") went off cameras.");
                    this.emitPlayerFlags(player.data.name, PlayerFlag.OnCams, false);
                } else {
                    this.log(LogMode.Warn, "Someone went off cameras, but there was no data.");
                }
            });

            this.log(LogMode.Success, "Initialized PublicLobbyBackend!");
        } catch (err) {
            this.log(LogMode.Error, "An error occurred.");
            this.log(LogMode.Error, err);
            this.emitError("An unknown error occurred, join the discord to contact an admin for help.", true);
            await this.destroy();
        }
    }

    awaitSpawns(): Promise<boolean> {
        return new Promise<boolean>(resolve => {
            const playersSpawned: number[] = [];
            let gamedataSpawned = false;

            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const _this = this;

            this.client.on("component.spawn", function onSpawn(ev) {
                const { component } = ev.data;
                if (component.classname === "GameData") {
                    gamedataSpawned = true;

                    const gamedata = component as GameData;
                    for (const [ , player ] of gamedata.players) {
                        if (player.name) _this.emitPlayerColor(player.name, player.color);
                    }
                } else if (component.classname === "PlayerControl") {
                    playersSpawned.push(component.ownerid);
                }
                
                if (gamedataSpawned) {
                    for (const [ clientid, ] of _this.client.players) {
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

    async awaitSettings(): Promise<GameOptions> {
        if (this.client.settings) {
            return this.client.settings;
        }

        const ev = await this.client.wait("player.syncsettings");

        return ev.data.settings;
    }

    async initialSpawn(isFinal = false): Promise<ConnectionErrorCode> {
        const ip = this.master[this.server][0];
        const port = this.master[this.server][1];
        
        this.log(LogMode.Info, "Joining for the first time with server %s:%i", ip, port);
        try {
            await this.client.connect(ip, undefined, undefined, port);
            if (!this.client)
                return ConnectionErrorCode.NoClient;
            await Promise.race([this.client.identify("auproxy", this.authToken), sleep(2000)]);
            if (!this.client.identified) {
                if (isFinal) this.emitError("Couldn't connect to the Among Us servers, the servers may be full. Try a different region or try again later.", true);
                return ConnectionErrorCode.TimedOut;
            }
        } catch (e) {
            this.log(LogMode.Fatal, e.toString());
            this.emitError("Couldn't connect to the Among Us servers, the servers may be full. Try a different region or try again later.", true);
            return ConnectionErrorCode.FailedToConnect;
        }
        this.log(LogMode.Success, "Successfully connected.");

        if (!this.client) {
            return ConnectionErrorCode.NoClient;
        }
        
        this.log(LogMode.Info, "Joining room..");
        try {
            const code = await Promise.race([this.client.joinGame(this.backendModel.gameCode, false), sleep(5000)]);
            if (!code) {
                if (isFinal) this.emitError("Timed out while connecting to servers.", true);
                return ConnectionErrorCode.TimedOut;
            }
        } catch (e) {
            this.log(LogMode.Fatal, e.toString());
            if (isFinal) this.emitError("Couldn't join the game, make sure that the game hasn't started and there is a spot for the client.", true);
            return ConnectionErrorCode.FailedToJoin;
        }

        this.log(LogMode.Success, "Successfully joined room.");
        this.log(LogMode.Info, "Waiting for spawns and settings..");
        const code = this.client.code;
        if (!code) {
            return ConnectionErrorCode.FailedToJoin;
        }

        this.client.spawnSelf();
        
        const result = await Promise.race([Promise.all([this.awaitSpawns(), this.awaitSettings()]), sleep(5000)]);
        if (!result) {
            this.log(LogMode.Fatal, "I didn't receive either spawns or settings from the host.");
            if (isFinal) this.emitError("Did not recieve players and settings, please restart your Among Us lobby, or wait a few minutes and try again.", true);
            return ConnectionErrorCode.TimedOut;
        }

        if (!this.client) {
            return ConnectionErrorCode.NoClient;
        }

        const [ , settings ] = result;
        
        if (!settings) {
            this.log(LogMode.Fatal, "I didn't receive settings from the host.");
            if (isFinal) this.emitError("Did not recieve game settings, please restart your Among Us lobby, or wait a few minutes and try again.", true);
            return ConnectionErrorCode.TimedOut;
        }
        
        this.settings.map = settings.map;
        this.settings.crewmateVision = settings.crewmateVision;
        this.emitSettingsUpdate({
            crewmateVision: this.settings.crewmateVision,
            map: settings.map
        });
        this.log(LogMode.Info, "Crewmate vision is at " + settings.crewmateVision);
        this.log(LogMode.Info, "Map is on " + MapID[settings.map]);
        
        if (this.client.host && this.client.host.data) {
            this.emitHostChange(this.client.host.data.name);
        }

        this.log(LogMode.Success, "Got spawns and settings.");
        this.log(LogMode.Info, "Cleaning up and preparing for re-join..");

        for (const [ , player ] of this.client.players) {
            if (player && player.data) {
                this.emitPlayerColor(player.data.name, player.data.color);
            }
        }

        const formatted = tb(text.bold(), text.color("blue"), text.align(text.Align.Center))
            .text("AUProximity is ready.");

        await this.client.me.control.checkName("ㆍ");
        await this.client.me.control.checkColor(ColorID.Blue);
        await this.client.me.wait("player.setname");
        await this.client.me.control.chat(formatted.toString());

        await sleep(100);
        
        await this.disconnect();
        return ConnectionErrorCode.None;
    }

    async destroy(): Promise<void> {
        if (this.destroyed)
            return;

        if (this.client && this.client.socket) {
            this.client.removeListeners("client.disconnect");
            await this.client.disconnect();
            this.client = undefined;
        }

        this.log(LogMode.Info, "Destroyed PublicLobbyBackend.");
        this.destroyed = true;
    }
}
