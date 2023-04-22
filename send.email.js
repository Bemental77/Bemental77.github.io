function sendEmail() {
    var sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    var name = document.getElementById('name').value;
    var emailaddress = document.getElementById('email').value;
    var message = document.getElementById('message').value;
    var msg = {
        to: 'caseybement@caseybement.com',
        from: 'contactcaseybement@gmail.com',
        subject: 'Message from your website',
        text: message,
        html: "<p>".concat(message, "</p><br><p>").concat(name, " <").concat(emailaddress, "></p>"),
    };
    sgMail
        .send(msg)
        .then(function () {
        console.log('Email sent');
        alert('Email sent successfully!');
    })
        .catch(function (error) {
        console.error(error);
        alert('There was a problem sending the email. Please try again later.');
    });
}
