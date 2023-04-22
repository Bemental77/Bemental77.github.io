const webpack = require('webpack');
const Dotenv = require('dotenv-webpack');

module.exports = {
  // other configuration options...
  plugins: [
    new Dotenv(),
    new webpack.DefinePlugin({
      'process.env.emailaddress': JSON.stringify(process.env.emailaddress),
      'process.env.password': JSON.stringify(process.env.password),
    }),
  ],
};
