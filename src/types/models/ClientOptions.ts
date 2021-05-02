import { GameMap } from "@skeldjs/constant";

export interface HostOptions {
    falloff: number;
    falloffVision: boolean;
    colliders: boolean;
    paSystems: boolean;
    commsSabotage: boolean;
    meetingsCommsSabotage: boolean;
}

export interface GameSettings {
    map: GameMap;
    crewmateVision: number;
}