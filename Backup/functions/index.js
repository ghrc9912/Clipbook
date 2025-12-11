// functions/index.js
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp();

// require and export hfChat
exports.hfChat = require("./hfChat").hfChat;
