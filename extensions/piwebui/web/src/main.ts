import { createApp } from "vue";
import { createPinia } from "pinia";

// Pixelium (pixel-art UI): base reset, component styles, pixel font.
import "@pixelium/web-vue/dist/normalize.css";
import "@pixelium/web-vue/dist/pixelium-vue.css";
import "@pixelium/web-vue/dist/font.css";
import "@pixelium/web-vue/dist/pixelium-vue-icon-pa.css";

import "./styles/app.css";
import App from "./App.vue";

// Light theme only: Pixelium's `:root.light` rule has higher specificity than its
// `prefers-color-scheme: dark` media query, so pinning the class keeps the UI white
// even when the OS is in dark mode.
document.documentElement.classList.remove("dark");
document.documentElement.classList.add("light");

createApp(App).use(createPinia()).mount("#app");
