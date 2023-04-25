<<<<<<< HEAD
function sendEmail() {
  const form = document.querySelector('form[name="theForm"]');
=======

// get the form element
const form = document.querySelector('form');
>>>>>>> ab72ae17b1e20db845cb49d4dd74594a6e875d3f

  if (form) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();

      const nameInput = document.querySelector('#name') as HTMLInputElement;
      const emailInput = document.querySelector('#email') as HTMLInputElement;
      const messageInput = document.querySelector('#message') as HTMLInputElement;

      const name = nameInput.value;
      const email = emailInput.value;
      const message = messageInput.value;

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

      const data = await response.json();
      console.log(data);
    });
<<<<<<< HEAD
  }
}
=======

    // do something with the response
    const data = await response.json();
    console.log(data);
  });

>>>>>>> ab72ae17b1e20db845cb49d4dd74594a6e875d3f
