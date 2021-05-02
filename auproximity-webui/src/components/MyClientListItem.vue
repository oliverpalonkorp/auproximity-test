<template>
  <v-list-group>
    <template v-slot:activator>
      <v-list-item-icon :color='client.color > -1 ? Colors[client.color] : undefined'>
        <i class="far fa-user me"></i>
      </v-list-item-icon>
      <v-list-item-content>
        <v-list-item-title>
          <span class="float-left">
            <i v-if="mic.levels > 10" class="fas fa-volume-up"></i>
            <i v-else class="fas fa-volume-off"></i>
            <span class="pl-3">{{ client.name }}</span>
            <span v-if="$store.state.host && $store.state.host.toLowerCase() === client.name.toLowerCase()">
              (HOST)
            </span>
          </span>
          <span class="float-right" v-if="mic.volumeNode">
            <span class="px-3">Connected</span>
          </span>
          <span class="float-right" v-else-if="$store.state.micAllowed">
            <span class="px-3">Disconnected</span>
          </span>
          <span class="float-right" v-else>
            <span class="px-3">Mic Blocked</span>
          </span>
        </v-list-item-title>
      </v-list-item-content>
    </template>
    <v-slider
      v-if="mic.volumeNode"
      thumb-label
      v-model="streamVolume"
      track-color="grey"
      always-dirty
      min="0"
      max="100"
      class="px-3"
    >
      <template v-slot:prepend>
        <v-icon>fa-microphone-slash</v-icon>
      </template>

      <template v-slot:append>
        <v-icon>fa-microphone</v-icon>
      </template>
    </v-slider>
  </v-list-group>
</template>

<script lang="ts">
import { Component, Vue, Prop } from 'vue-property-decorator'
import { ClientModel, MyMicModel, ColorID } from '@/models/ClientModel'

@Component({})
export default class MyClientListItem extends Vue {
  @Prop()
  client!: ClientModel;

  @Prop()
  mic!: MyMicModel;

  Colors = {
    [ColorID.Red]: '#7a0838',
    [ColorID.Blue]: '#09158e',
    [ColorID.DarkGreen]: '#0a4d2e',
    [ColorID.Pink]: '#ac2bae',
    [ColorID.Orange]: '#b43e15',
    [ColorID.Yellow]: '#c38822',
    [ColorID.Black]: '#1e1f26',
    [ColorID.White]: '#8495c0',
    [ColorID.Purple]: '#3b177c',
    [ColorID.Brown]: '#5e2615',
    [ColorID.Cyan]: '#24a9bf',
    [ColorID.Lime]: '#15a842'
  }

  get streamVolume () {
    if (typeof this.mic.volumeNode !== 'undefined') {
      return this.mic.volumeNode.gain.value * 100
    }
    return undefined
  }

  set streamVolume (val) {
    if (typeof this.mic.volumeNode !== 'undefined') {
      this.mic.volumeNode.gain.value = val ? val / 100 : 0
    }
  }
}
</script>
