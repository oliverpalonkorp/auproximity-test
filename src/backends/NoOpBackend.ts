import { BackendType, BackendModel } from "../types/models/Backends";

import { BackendAdapter, LogMode} from "./Backend";

export default class NoOpBackend extends BackendAdapter {
    backendModel: BackendModel;

    constructor() {
        super();

        this.backendModel = {
            backendType: BackendType.NoOp,
            gameCode: "NOPNOP"
        };

        this.gameID = this.backendModel.gameCode;
    }

    initialize(): void {
        this.log(LogMode.Info, "Initialized NoOp backend.");
    }

    destroy(): void {
        this.log(LogMode.Info, "Destroying NoOp backend.");
    }
}
