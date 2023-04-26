"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const nodemailer_1 = __importDefault(require("nodemailer"));
async function sendEmail(formData) {
    const transporter = nodemailer_1.default.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: {
            user: process.env.EMAIL_ADDRESS,
            pass: process.env.EMAIL_PASSWORD,
        },
    });
    try {
        await transporter.sendMail({
            from: `"${formData.name}" <${formData.email}>`,
            to: 'caseybement@caseybement.com',
            subject: 'Message from your website',
            text: formData.message,
        });
        return { message: 'Email sent successfully!' };
    }
    catch (error) {
        console.error(error);
        throw new Error('There was a problem sending the email.');
    }
}
exports.default = sendEmail;
