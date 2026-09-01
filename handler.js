const AWS = require('aws-sdk');

exports.handler = async (event, context) => {
  const ses = new AWS.SES({ region: 'us-east-1' }); // Replace with your desired region
  const { name, email, message } = JSON.parse(event.body);
  const params = {
    Destination: {
      ToAddresses: 'caseybement@caseybement.com', // Use the recipient from the request body
    },
    Message: {
      Body: {
        Text: {
          Data: message,
          from: name,
          emailSentFrom: email // Use the content from the request body
        },
      },
      Subject: {
        Data: 'Serverless function email', // Replace with your email subject
      },
    },
    Source: 'caseybement@caseybement.com', // Replace with your verified email address
  };
  try {
    const result = await ses.sendEmail(params).promise();
    console.log('Email sent:', result);
    return { statusCode: 200, body: 'Email sent' };
  } catch (error) {
    console.error(error);
    return { statusCode: 500, body: 'Error sending email' };
  }
};
