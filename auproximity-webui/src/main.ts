import Vue from "vue";
import * as Sentry from "@sentry/browser";
import * as Integrations from "@sentry/integrations";
import App from "./App.vue";
import router from "./router";
import store from "./store";
import vuetify from "./plugins/vuetify";
import VueSocketIOExt from "vue-socket.io-extended";
import { io } from "socket.io-client";
import "@fortawesome/fontawesome-free/css/all.min.css";
import consts from "@/consts";

if (typeof process.env.VUE_APP_SENTRY_DSN !== "undefined") {
	console.log("Enabling automatic and anonymous error reporting");
	Sentry.init({
		dsn: process.env.VUE_APP_SENTRY_DSN,
		integrations: [new Integrations.Vue({ Vue, attachProps: true })],
	});
} else {
	console.log("Not enabling automatic error reporting");
}

Vue.config.devtools = true;
Vue.config.productionTip = false;

Vue.use(VueSocketIOExt, io(consts.SERVER_URL), { store });

new Vue({
	router,
	store,
	vuetify,
	render: (h) => h(App),
}).$mount("#app");
