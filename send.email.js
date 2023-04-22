function sendEmail() {
    var _a, _b, _c;
    var name = (_a = document.getElementById("name")) === null || _a === void 0 ? void 0 : _a.value;
    var email = (_b = document.getElementById("email")) === null || _b === void 0 ? void 0 : _b.value;
    var message = (_c = document.getElementById("message")) === null || _c === void 0 ? void 0 : _c.value;
    var emailBody = "Name: ".concat(name, "\nEmail: ").concat(email, "\nMessage: ").concat(message);
    fetch('https://api.example.com/send-email', {
        method: 'POST',
        body: emailBody,
        headers: {
            'Content-Type': 'text/plain'
        }
    })
        .then(function (response) {
        if (!response.ok) {
            throw new Error('Network response was not ok');
        }
        alert('Email sent successfully!');
        document.getElementById('name').value = '';
        document.getElementById('email').value = '';
        document.getElementById('message').value = '';
    })
        .catch(function (error) {
        console.error('There was a problem sending the email:', error);
        alert('There was a problem sending the email. Please try again later.');
    });
}
