import { config } from "dotenv";
config();

function sendEmail(): void {
  const name = (<HTMLInputElement>document.getElementById("name"))?.value;
  const email = (<HTMLInputElement>document.getElementById("email"))?.value;
  const message = (<HTMLInputElement>document.getElementById("message"))?.value;

  const emailBody = `From: ${name} <${email}>\r\nTo: caseybement@caseybement.com\r\nSubject: Message from your website\r\n\r\n${message}`;
  
  fetch('https://smtp.gmail.com:587', {
    method: 'POST',
    body: emailBody,
    headers: {
      'Content-Type': 'text/plain',
      'Authorization': `Basic ${btoa(`${process.env.EMAIL_ADDRESS}:${process.env.PASSWORD}`)}`,
      'X-Requested-With': 'XMLHttpRequest'
    }
  })
  .then(response => {
    if (!response.ok) {
      throw new Error('Network response was not ok');
    }
    alert('Email sent successfully!');
    (<HTMLInputElement>document.getElementById('name')).value = '';
    (<HTMLInputElement>document.getElementById('email')).value = '';
    (<HTMLInputElement>document.getElementById('message')).value = '';
  })
  .catch(error => {
    console.error('There was a problem sending the email:', error);
    alert('There was a problem sending the email. Please try again later.');
  });
}
