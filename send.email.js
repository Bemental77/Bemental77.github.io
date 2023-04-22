"use strict";
var config_js_1 = require("./config.js");
function sendEmail() {
    var _a, _b, _c;
    var name = (_a = document.getElementById("name")) === null || _a === void 0 ? void 0 : _a.value;
    var emailaddress = (_b = document.getElementById("email")) === null || _b === void 0 ? void 0 : _b.value;
    var message = (_c = document.getElementById("message")) === null || _c === void 0 ? void 0 : _c.value;
    var emailBody = "From: ".concat(name, " <").concat(emailaddress, ">\r\nTo: caseybement@caseybement.com\r\nSubject: Message from your website\r\n\r\n").concat(message);
    fetch('https://smtp.sendgrid.net:587', {
        method: 'POST',
        body: emailBody,
        headers: {
            'Content-Type': 'text/plain',
            'Authorization': "Basic ".concat(btoa("".concat('apikey', ":").concat(window.config.PASSWORD))),
            'X-Requested-With': 'XMLHttpRequest'
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
    console.log(config_js_1.config.EMAIL_ADDRESS)
}
