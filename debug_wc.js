import { SignClient } from "@walletconnect/sign-client";

console.log("Type of Named SignClient:", typeof SignClient);
if (typeof SignClient === 'function') {
    console.log("Is .init available on Named?", typeof SignClient.init);
} else {
    console.log("Named export is not a function/class");
}

import DefaultSignClient from "@walletconnect/sign-client";
console.log("Default export keys:", Object.keys(DefaultSignClient));