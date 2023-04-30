const AWS = require('aws-sdk');
const apiId = 'YOUR_API_ID';
const region = 'YOUR_REGION';

// Set the access key ID and secret access key
const credentials = new AWS.Credentials({
  accessKeyId: 'YOUR_ACCESS_KEY_ID',
  secretAccessKey: 'YOUR_SECRET_ACCESS_KEY'
});

// Set up the API Gateway Management API client
const apigwManagementApi = new AWS.ApiGatewayManagementApi({
  apiVersion: '2018-11-29',
  endpoint: `${apiId}.execute-api.${region}.amazonaws.com`
});

// Make a request to your serverless function
apigwManagementApi.postToConnection({
  ConnectionId: 'YOUR_CONNECTION_ID',
  Data: 'Hello, world!'
}, function(err, data) {
  if (err) {
    console.log(err);
  } else {
    console.log('Message sent successfully');
  }
});
