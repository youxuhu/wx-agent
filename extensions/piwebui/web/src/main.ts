import { createApp } from "vue";
import { createPinia } from "pinia";

import "./styles/app.css";
import App from "./App.vue";

// Light theme only, on purpose (system dark mode must not repaint the panel).
document.documentElement.className = "light";
document.documentElement.style.colorScheme = "light";

createApp(App).use(createPinia()).mount("#app");
