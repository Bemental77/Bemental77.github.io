"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const send_service_1 = __importDefault(require("/Users/caseybement/Bemental77.github.io/sendemail/pages/api/send.service"));
async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).json({ message: 'Method not allowed' });
        return;
    }
    const formDataName = req.body.name;
    const formDataEmail = req.body.email;
    const formDataMessage = req.body.message;
    let formData = {
        name: formDataName,
        email: formDataEmail,
        message: formDataMessage
    };
    try {
        const response = await (0, send_service_1.default)(formData);
        res.status(200).json(response);
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ message: error });
    }
}
exports.handler = handler;
