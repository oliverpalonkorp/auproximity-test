<template>
	<v-list-group>
		<template v-slot:activator>
			<v-list-item-icon
				:color="client.color > -1 ? Colors[client.color] : undefined"
			>
				<i class="fas fa-user"></i>
			</v-list-item-icon>
			<v-list-item-content>
				<v-list-item-title>
					<span class="float-left">
						<i v-if="stream && stream.levels > 10" class="fas fa-volume-up"></i>
						<i v-else class="fas fa-volume-off"></i>
						<span class="pl-3">{{ client.name.trim() }}</span>
						<span
							v-if="
								$store.state.host &&
								$store.state.host.toLowerCase().trim() ===
									client.name.toLowerCase().trim()
							"
						>
							(HOST)
						</span>
					</span>
					<span class="float-right" v-if="stream !== undefined">
						<span class="px-3">Connected</span>
					</span>
					<span class="float-right" v-else>
						<span class="px-3">Disconnected</span>
					</span>
				</v-list-item-title>
			</v-list-item-content>
		</template>
		<v-row class="px-4 pt-6">
			<v-slider
				v-if="stream"
				thumb-label
				v-model="stream.volumeNode.gain.value"
				track-color="grey"
				always-dirty
				min="0"
				max="1"
				step="0.01"
				class="px-3"
			>
				<template v-slot:prepend>
					<v-btn icon @click="decVolume">
						<v-icon>fa-volume-mute</v-icon>
					</v-btn>
				</template>

				<template v-slot:append>
					<v-btn icon @click="incVolume">
						<v-icon>fa-volume-down</v-icon>
					</v-btn>
				</template>

				<template v-slot:thumb-label="{ value }">
					{{ ~~(value * 100) }}
				</template>
			</v-slider>
			<div v-if="$store.state.host === $store.state.me.uuid">
				<v-btn color="primary" class="mx-1" @click="() => removeClient(false)"
					>Kick</v-btn
				>
				<v-btn color="error" class="mx-1" @click="() => removeClient(true)"
					>Ban</v-btn
				>
			</div>
		</v-row>
	</v-list-group>
</template>

<script lang="ts">
import { Component, Vue, Prop } from "vue-property-decorator";
import { ClientModel, RemoteStreamModel, ColorID } from "@/models/ClientModel";
import { ClientSocketEvents } from "@/models/ClientSocketEvents";

@Component({})
export default class ClientListItem extends Vue {
	@Prop()
	client!: ClientModel;

	@Prop()
	streams!: RemoteStreamModel[];

	Colors = {
		[ColorID.Red]: "#7a0838",
		[ColorID.Blue]: "#09158e",
		[ColorID.DarkGreen]: "#0a4d2e",
		[ColorID.Pink]: "#ac2bae",
		[ColorID.Orange]: "#b43e15",
		[ColorID.Yellow]: "#c38822",
		[ColorID.Black]: "#1e1f26",
		[ColorID.White]: "#8495c0",
		[ColorID.Purple]: "#3b177c",
		[ColorID.Brown]: "#5e2615",
		[ColorID.Cyan]: "#24a9bf",
		[ColorID.Lime]: "#15a842",
	};

	removeClient(ban: boolean) {
		this.$socket.client.emit(ClientSocketEvents.RemoveClient, {
			uuid: this.client.uuid,
			ban,
		});
	}

	decVolume() {
		if (this.stream) {
			this.stream.volumeNode.gain.value = Math.max(
				this.stream.volumeNode.gain.value - 0.02,
				0
			);
			this.$forceUpdate();
		}
	}

	incVolume() {
		if (this.stream) {
			this.stream.volumeNode.gain.value = Math.max(
				this.stream.volumeNode.gain.value + 0.02,
				0
			);
			this.$forceUpdate();
		}
	}

	get stream() {
		return this.streams.find((s) => s.uuid === this.client.uuid);
	}
}
</script>
