import Toastify from 'toastify-js';
import 'toastify-js/src/toastify.css';


export function showToast() {
  return Toastify({
    text: "Message sent!",
    backgroundColor: "linear-gradient(to right, #00b09b, #96c93d)",
    className: "info",
  });
}