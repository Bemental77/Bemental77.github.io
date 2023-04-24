
// get the form element
const form = document.querySelector('form');

if (form) { // check if the form element exists
  // add event listener to the form on submit
  form.addEventListener('submit', async (event) => {
    // prevent default form submission behavior
    event.preventDefault();

    const nameInput = document.querySelector('#name') as HTMLInputElement;
    const emailInput = document.querySelector('#email') as HTMLInputElement;
    const messageInput = document.querySelector('#message') as HTMLInputElement;

    const name = nameInput.value;
    const email = emailInput.value;
    const message = messageInput.value;


    // make the fetch request
    const response = await fetch('sendemail/pages/api/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name,
        email,
        message
      })
    });

    // do something with the response
    const data = await response.json();
    console.log(data);
  });

