=====================================================
  AR WA GROUP MESSAGE FORWARD
  A smart and efficient WhatsApp Group Message
  Forwarding Software.
=====================================================

Developed by : Ariful Islam
Phone        : +880 1307-432200
Email        : arifulislam4390@gmail.com
Version      : 1.5.0

-----------------------------------------------------

AR WhatsApp Group Message Forwarder — README
=============================================

WHAT IT DOES
------------
* Reads new messages from ONE source WhatsApp group.
* Sends the SAME message to as many target groups as you choose.
* The text is sent EXACTLY as received:
    - no added text, no prefix, no suffix
    - emoji, numbers and line breaks stay identical
    - nothing is trimmed or reformatted
* Images, PDFs, videos, audio and stickers are NEVER forwarded.
* Schedule: every day 09:50 – 16:28 (start included, end excluded).
  A message that arrives outside that window is not forwarded.
* Runs on Windows 10 / 11 (64-bit). Nothing else to install.

HOW TO RUN
----------
1. Open the folder "AR WhatsApp Forwarder-win32-x64".
2. Double-click  "AR WhatsApp Forwarder.exe".
3. Press "Connect WhatsApp".
   A QR code appears in the app — scan it with your phone:
   WhatsApp -> Linked devices -> Link a device.
4. Choose the SOURCE group and tick the TARGET groups, then "Save groups".
5. Check the schedule (default 09:50 – 16:28) and press "Save settings".
6. Leave the app running. Messages that arrive in the source group between
   09:50 and 16:28 are forwarded automatically.

First run needs internet. After that the login is remembered on this PC.

TIPS
----
* "Test send" sends a message you type to the selected target groups — use it
  once to confirm everything works.
* "Delay between groups" (default 3 s) makes sending safer for your account.
* "Daily limit" stops forwarding after N messages per day (0 = unlimited).
* "Open log file" shows a full record of every forward.
* Keep your phone connected to the internet; WhatsApp Web needs it.

FOLDER CONTENTS
---------------
* AR WhatsApp Forwarder.exe ... start the app
* resources\app.asar .......... the application code
* README.txt .................. this file

WHERE SETTINGS ARE KEPT
-----------------------
%APPDATA%\AR WhatsApp Forwarder\
  settings.json   your groups, schedule and history
  activity.log    log of every action
  wwebjs_auth\    the saved WhatsApp login

NOTE
----
This tool forwards plain text only, exactly as asked. Do not use it for bulk
spam; WhatsApp may limit accounts that send to many groups very fast. The
built-in delay and daily limit exist to keep the account safe.
