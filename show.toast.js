"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.showToast = void 0;
var toastify_js_1 = require("toastify-js");
require("toastify-js/src/toastify.css");
function showToast() {
    return (0, toastify_js_1.default)({
        text: "Message sent!",
        backgroundColor: "linear-gradient(to right, #00b09b, #96c93d)",
        className: "info",
    });
}
exports.showToast = showToast;
