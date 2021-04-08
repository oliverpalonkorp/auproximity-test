import { MapID } from "@skeldjs/constant";

export interface HostOptions {
    falloff: number;
    falloffVision: boolean;
    colliders: boolean;
    paSystems: boolean;
    commsSabotage: boolean;
    meetingsCommsSabotage: boolean;
}

export interface GameSettings {
    map: MapID;
    crewmateVision: number;
}