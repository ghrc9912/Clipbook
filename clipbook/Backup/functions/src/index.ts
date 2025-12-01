// functions/src/index.ts
import * as admin from "firebase-admin";

// Initialize admin (only once)
if (!admin.apps.length) {
  admin.initializeApp();
}

// Export the hfChat function (implemented in hfChat.ts)
export { hfChat } from "./hfChat";
