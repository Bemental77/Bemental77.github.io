import type { NextApiRequest, NextApiResponse } from 'next';
import sendEmail from '/Users/caseybement/Bemental77.github.io/sendemail/pages/api/send.service'

export async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{ message: string }>
) {
  if (req.method !== 'POST') {
    res.status(405).json({ message: 'Method not allowed' });
    return;
  }

  const formDataName = req.body.name
  const formDataEmail = req.body.email
  const formDataMessage = req.body.message

  let formData = {
    name: formDataName,
    email: formDataEmail,
    message: formDataMessage
  }

  try {
    const response = await sendEmail(formData);
    res.status(200).json(response);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: error as string });
  }
}
