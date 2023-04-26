async function sendEmailClientSide() {
  const nameInput = document.querySelector('#name') as HTMLInputElement;
  const emailInput = document.querySelector('#email') as HTMLInputElement;
  const messageInput = document.querySelector('#message') as HTMLInputElement;

  const name = nameInput.value;
  const email = emailInput.value;
  const message = messageInput.value;

  const response = await fetch('/api/send', {
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
}

