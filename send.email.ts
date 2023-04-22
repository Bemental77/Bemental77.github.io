function sendEmail() {
  const sgMail = require('@sendgrid/mail');
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  const name = (<HTMLInputElement>document.getElementById('name')).value;
  const emailaddress = (<HTMLInputElement>document.getElementById('email')).value;
  const message = (<HTMLTextAreaElement>document.getElementById('message')).value;

  const msg = {
    to: 'caseybement@caseybement.com', // Change to your recipient
    from: 'contactcaseybement@gmail.com', // Change to your verified sender
    subject: 'Message from your website',
    text: message,
    html: `<p>${message}</p><br><p>${name} <${emailaddress}></p>`,
  };

  sgMail
    .send(msg)
    .then(() => {
      console.log('Email sent');
      alert('Email sent successfully!');
    })
    .catch((error) => {
      console.error(error);
      alert('There was a problem sending the email. Please try again later.');
    });
}
