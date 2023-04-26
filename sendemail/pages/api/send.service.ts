import * as nodemailer from 'nodemailer';

export interface FormData {
  name: string,
  email: string,
  message: string
}

export default async function sendEmail(formData: FormData): Promise<{ message: string }> {
  const transporter = nodemailer.createTransport({
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
  } catch (error) {
    console.error(error);
    throw new Error('There was a problem sending the email.');
  }
}