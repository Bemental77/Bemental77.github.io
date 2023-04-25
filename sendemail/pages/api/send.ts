import type { NextApiRequest, NextApiResponse } from 'next';
import nodemailer from 'nodemailer';

type FormData = {
  name: string;
  email: string;
  message: string;
};

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

export async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{ message: string }>
) {
  if (req.method !== 'POST') {
    res.status(405).json({ message: 'Method not allowed' });
    return;
  }

  const formData = req.body as FormData;

  try {
    const response = await sendEmail(formData);
    res.status(200).json(response);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: error as string });
  }
}
