function sendEmail(): void {
  const name = (document.getElementById("name") as HTMLInputElement)?.value as string;
  const email = (document.getElementById("email") as HTMLInputElement)?.value as string;
  const message = (document.getElementById("message") as HTMLTextAreaElement)?.value as string;

  const emailBody = `Name: ${name}\nEmail: ${email}\nMessage: ${message}`;

  fetch('https://api.example.com/send-email', {
    method: 'POST',
    body: emailBody,
    headers: {
      'Content-Type': 'text/plain'
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
