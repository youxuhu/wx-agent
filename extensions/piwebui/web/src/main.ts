import { createApp } from "vue";
import { createPinia } from "pinia";

// Pixelium (pixel-art UI): base reset, component styles, pixel font.
import "@pixelium/web-vue/dist/normalize.css";
import "@pixelium/web-vue/dist/pixelium-vue.css";
import "@pixelium/web-vue/dist/font.css";
import "@pixelium/web-vue/dist/pixelium-vue-icon-pa.css";

import "./styles/app.css";
import App from "./App.vue";

createApp(App).use(createPinia()).mount("#app");
