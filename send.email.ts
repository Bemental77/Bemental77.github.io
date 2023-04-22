import { config } from 'dotenv';
config()

function sendEmail(): void {
  const name = (document.getElementById("name") as HTMLInputElement)?.value as string;
  const email = (document.getElementById("email") as HTMLInputElement)?.value as string;
  const message = (document.getElementById("message") as HTMLTextAreaElement)?.value as string;

  const emailBody = `From: ${name} <${email}>\r\nTo: caseybement@caseybement.com\r\nSubject: Message from your website\r\n\r\n${message}`;

  const emailAddress = process.env.emailaddress;
  const password = process.env.password;

  fetch('https://smtp.gmail.com:587', {
    method: 'POST',
    body: emailBody,
    headers: {
      'Content-Type': 'text/plain',
      'Authorization': `Basic ${btoa(`${emailAddress}:${password}`)}`,
      'X-Requested-With': 'XMLHttpRequest'
    }
  })
    .then(response => {
      if (!response.ok) {
        throw new Error('Network response was not ok');
      }
      alert('Email sent successfully!');
      (document.getElementById('name') as HTMLInputElement).value = '';
      (document.getElementById('email') as HTMLInputElement).value = '';
      (document.getElementById('message') as HTMLTextAreaElement).value = '';
    })
    .catch(error => {
      console.error('There was a problem sending the email:', error);
      alert('There was a problem sending the email. Please try again later.');
    });
}
